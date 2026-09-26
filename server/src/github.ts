// Turns GitHub PRs and issues into their current state (source_item) and conversations (conversation / message).
//
// **The only path is `gh`.** There is one owner, so `gh auth` works as is. Sync writes to that machine's database, so
// one machine running it daily is enough for every machine to search it.
//
// One PR or issue is one conversation; its body, comments, and review comments are one message each.
// Review replies point to their parent with reply_to, and the files they point at go in message_file (found by "about this file").
// **The whole list is fetched every time.** Reflecting deleted comments and PRs needs a complete list, and an owner's repository takes seconds.
// Only rows whose content hash changed are written.
// Every string from GitHub goes through clean() (a single NUL fails the whole transaction and stops the daily sync).

import { execFileSync } from "node:child_process";
import type { Kysely } from "kysely";
import { inTransaction, iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { syncDecisions } from "./decisions.ts";
import { conversationId, indexesMessage, type SpeakerKind } from "./knowledge.ts";
import { connectorOf } from "./project.ts";
import { bytes, clean, plural, sha256, uuidFrom } from "./text.ts";

type User = { id: number; login: string } | null;

type Pull = {
  number: number;
  title: string;
  body: string | null;
  user: User;
  state: string;
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
};

type RawIssue = {
  number: number;
  title: string;
  body: string | null;
  user: User;
  state: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  /** Present on PRs. The issues endpoint also returns PRs */
  pull_request?: unknown;
};

type ReviewComment = {
  id: number;
  in_reply_to_id?: number;
  user: User;
  body: string;
  path: string;
  line: number | null;
  start_line?: number | null;
  created_at: string;
  html_url: string;
  pull_request_url: string;
};

type IssueComment = {
  id: number;
  user: User;
  body: string;
  created_at: string;
  html_url: string;
  issue_url: string;
};

export type GithubSource = {
  pulls: () => Promise<Pull[]>;
  issues: () => Promise<RawIssue[]>;
  reviewComments: () => Promise<ReviewComment[]>;
  issueComments: () => Promise<IssueComment[]>;
};

function gh(repo: string, endpoint: string): unknown[] {
  const out = execFileSync("gh", ["api", `repos/${repo}/${endpoint}`, "--paginate", "--slurp"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (JSON.parse(out) as unknown[][]).flat();
}

const cliSource = (repo: string): GithubSource => ({
  pulls: async () => gh(repo, "pulls?state=all&per_page=100") as Pull[],
  issues: async () => gh(repo, "issues?state=all&per_page=100") as RawIssue[],
  reviewComments: async () => gh(repo, "pulls/comments?per_page=100") as ReviewComment[],
  issueComments: async () => gh(repo, "issues/comments?per_page=100") as IssueComment[],
});

// AI reviews have substance, so they are kept. Only automated notices without reasoning are dropped (Terraform plans, deploy URLs,
// coverage tables, dependency updates). They are matched by name because matching the body breaks whenever the format changes.
const AI_REVIEWERS = new Set([
  "gemini-code-assist[bot]",
  "coderabbitai[bot]",
  "cursor[bot]",
  "claude[bot]",
  "chatgpt-codex-connector[bot]",
  "Copilot",
]);

export type Speaker = Exclude<SpeakerKind, "self">;
export const speakerOf = (login: string): Speaker =>
  AI_REVIEWERS.has(login) ? "assistant" : login.endsWith("[bot]") ? "bot" : "person";

// Acknowledgments are not knowledge. **Length alone does not drop a message** — a 10-character reply can still carry content.
const FILLER =
  // english-exempt: matches Japanese acknowledgments that people write
  /^(lgtm|ok(です)?|了解(です)?|確認しました|ありがとうございます?|修正しました|対応しました|なるほど|承知(しました)?|わかりました|👍|:\+1:|:eyes:|:pray:)[!！。.\s]*$/i;
export const isFiller = (body: string): boolean => {
  const t = body.trim();
  return t.length === 0 || FILLER.test(t) || /^!?\[[^\]]*\]\([^)]*\)$/.test(t);
};

type Item = {
  kind: "pull_request" | "issue";
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  url: string;
  author: User;
  createdAt: string;
  updatedAt: string;
  /** When it was merged (PR) or closed. null while open */
  closedAt: string | null;
};

type Said = {
  /** Unique within the conversation: `body` for the body, `c:<id>` for comments, `r:<id>` for reviews */
  externalId: string;
  replyTo: string | null;
  author: User;
  speaker: Speaker;
  body: string;
  url: string;
  at: string;
  file: { path: string; line: number | null; startLine: number | null } | null;
};

export type Collected = { items: Item[]; said: Map<number, Said[]> };

/** Collects PR and issue bodies, comments, and reviews into the shape to write. */
export async function collect(source: GithubSource): Promise<Collected> {
  const items = new Map<number, Item>();
  // When a PR or comment arrives during paging, the item at the boundary appears on two pages. Keep one message per id
  // (a batch upsert with the same id twice fails the whole transaction).
  const said = new Map<number, Map<string, Said>>();
  const push = (n: number, s: Said) => said.set(n, (said.get(n) ?? new Map()).set(s.externalId, s));
  const who = (u: User): User => (u ? { id: u.id, login: clean(u.login) } : null);
  const body = (n: number, author: User, text: string | null, at: string, url: string) => {
    const t = clean(text ?? "").trim();
    if (!t || !author) return;
    push(n, {
      externalId: "body",
      replyTo: null,
      author,
      speaker: speakerOf(author.login),
      body: t,
      url,
      at,
      file: null,
    });
  };

  for (const p of await source.pulls()) {
    // **PRs created by bots are kept.** Release PRs come from release-bot, and dropping them loses what shipped when.
    const state = p.merged_at ? "merged" : p.state === "open" ? "open" : "closed";
    const url = clean(p.html_url);
    items.set(p.number, {
      kind: "pull_request",
      number: p.number,
      title: clean(p.title),
      state,
      url,
      author: who(p.user),
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      closedAt: state === "open" ? null : (p.merged_at ?? p.closed_at ?? p.updated_at),
    });
    body(p.number, who(p.user), p.body, p.created_at, url);
  }
  for (const i of await source.issues()) {
    // The issues endpoint also returns PRs. **Issues created by bots are skipped** (they are only recurring reports).
    if (i.pull_request || speakerOf(i.user?.login ?? "") === "bot") continue;
    const state = i.state === "open" ? "open" : "closed";
    const url = clean(i.html_url);
    items.set(i.number, {
      kind: "issue",
      number: i.number,
      title: clean(i.title),
      state,
      url,
      author: who(i.user),
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      closedAt: state === "open" ? null : (i.closed_at ?? i.updated_at),
    });
    body(i.number, who(i.user), i.body, i.created_at, url);
  }

  const keep = (author: User, text: string) =>
    Boolean(author) && speakerOf(author?.login ?? "") !== "bot" && !isFiller(text);
  for (const r of await source.reviewComments()) {
    const n = Number(r.pull_request_url.split("/").pop());
    if (!items.has(n) || !keep(r.user, r.body)) continue;
    push(n, {
      externalId: `r:${r.id}`,
      replyTo: r.in_reply_to_id ? `r:${r.in_reply_to_id}` : null,
      author: who(r.user),
      speaker: speakerOf(r.user?.login ?? ""),
      body: clean(r.body).trim(),
      url: clean(r.html_url),
      at: r.created_at,
      file: { path: clean(r.path), line: r.line ?? null, startLine: r.start_line ?? null },
    });
  }
  for (const c of await source.issueComments()) {
    const n = Number(c.issue_url.split("/").pop());
    if (!items.has(n) || !keep(c.user, c.body)) continue;
    push(n, {
      externalId: `c:${c.id}`,
      replyTo: null,
      author: who(c.user),
      speaker: speakerOf(c.user?.login ?? ""),
      body: clean(c.body).trim(),
      url: clean(c.html_url),
      at: c.created_at,
      file: null,
    });
  }
  // When the parent of a reply was dropped (an acknowledgment), keep the reply without a parent.
  const lists = new Map([...said].map(([n, m]) => [n, [...m.values()]]));
  for (const list of lists.values()) {
    const ids = new Set(list.map((s) => s.externalId));
    for (const s of list) if (s.replyTo && !ids.has(s.replyTo)) s.replyTo = null;
  }
  return { items: [...items.values()], said: lists };
}

const itemHash = (i: Item): Buffer =>
  sha256(
    JSON.stringify([
      i.kind,
      i.title,
      i.state,
      i.url,
      i.author?.id ?? null,
      i.createdAt,
      i.updatedAt,
      i.closedAt,
    ]),
  );

// Keep the number of variables per statement well below SQLite's limit (32,766).
const chunks = <T>(xs: T[], n = 1000): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/**
 * Syncs one project's GitHub. repo is `owner/name`.
 * **Nothing is written when reading started before the snapshot already stored** (a late commit never rolls back a newer state).
 */
export async function syncGithub(
  db: Kysely<DB>,
  projectId: number,
  repo: string,
  source: GithubSource = cliSource(repo),
): Promise<string> {
  // When reading started. Syncs on the same machine are compared, so this machine's clock is enough (each machine has its own database).
  const snapshotAt = iso(Date.now());
  const { items, said } = await collect(source);

  const counts = await inTransaction(db, async (trx) => {
    const connector = await connectorOf(trx, projectId, "github");
    // If another sync stored a newer fetch after this one started, write nothing (an older, late fetch never rolls it back).
    if (connector.snapshotAt && snapshotAt < connector.snapshotAt) return null;

    // Speakers. Logins can change, so they are linked by user id, and handle follows the current login.
    const users = new Map<number, string>();
    for (const i of items) if (i.author) users.set(i.author.id, i.author.login);
    for (const list of said.values())
      for (const s of list) if (s.author) users.set(s.author.id, s.author.login);
    const ids = new Map<number, number>();
    for (const part of chunks([...users]))
      await trx
        .insertInto("person_identity")
        .values(part.map(([id, handle]) => ({ provider: "github", external_id: String(id), handle })))
        .onConflict((oc) =>
          oc
            .columns(["provider", "external_id"])
            .doUpdateSet((eb) => ({ handle: eb.ref("excluded.handle") }))
            .where("person_identity.handle", "<>", (eb) => eb.ref("excluded.handle")),
        )
        .execute();
    for (const part of chunks([...users.keys()].map(String)))
      for (const x of await trx
        .selectFrom("person_identity")
        .select(["id", "external_id"])
        .where("provider", "=", "github")
        .where("external_id", "in", part)
        .execute())
        ids.set(Number(x.external_id), x.id);
    const identity = (u: User) => (u ? (ids.get(u.id) ?? null) : null);

    const known = new Map(
      (
        await trx
          .selectFrom("source_item")
          .select(["id", "external_id", "content_hash"])
          .where("connector_id", "=", connector.id)
          .execute()
      ).map((r) => [r.external_id, r]),
    );
    // Read the stored messages in one query. Unchanged PRs and issues need no round trip.
    const stored = new Map(
      (
        await trx
          .selectFrom("message as m")
          .innerJoin("conversation as c", "c.id", "m.conversation_id")
          .innerJoin("source_item as s", "s.id", "c.source_item_id")
          .select(["m.id", "m.content_hash"])
          .where("s.connector_id", "=", connector.id)
          .execute()
      ).map((r) => [r.id, r.content_hash]),
    );

    const sourceId = new Map([...known].map(([n, r]) => [n, r.id]));
    // A PR or issue keeps the conversation it already has, so its ids (and message ids) survive a repository rename.
    const existing = new Map(
      (
        await trx
          .selectFrom("conversation as c")
          .innerJoin("source_item as s", "s.id", "c.source_item_id")
          .select(["c.id", "c.source_item_id"])
          .where("c.project_id", "=", projectId)
          .where("c.origin", "=", "github")
          .where("s.connector_id", "=", connector.id)
          .execute()
      ).map((r) => [r.source_item_id, r.id]),
    );
    const conversationOf = (source: number, number: number): string =>
      existing.get(source) ?? conversationId(projectId, "github", `${repo}#${number}`);
    const changedItems = items.filter((i) => !known.get(String(i.number))?.content_hash.equals(itemHash(i)));
    for (const part of chunks(changedItems)) {
      const rows = await trx
        .insertInto("source_item")
        .values(
          part.map((i) => ({
            connector_id: connector.id,
            external_id: String(i.number),
            kind: i.kind,
            title: i.title,
            state: i.state,
            url: i.url,
            author_identity_id: identity(i.author),
            source_created_at: iso(i.createdAt),
            source_updated_at: iso(i.updatedAt),
            closed_at: i.closedAt === null ? null : iso(i.closedAt),
            content_hash: itemHash(i),
            synced_at: snapshotAt,
          })),
        )
        .onConflict((oc) =>
          oc.columns(["connector_id", "external_id"]).doUpdateSet((eb) => ({
            kind: eb.ref("excluded.kind"),
            title: eb.ref("excluded.title"),
            state: eb.ref("excluded.state"),
            url: eb.ref("excluded.url"),
            author_identity_id: eb.ref("excluded.author_identity_id"),
            source_created_at: eb.ref("excluded.source_created_at"),
            source_updated_at: eb.ref("excluded.source_updated_at"),
            closed_at: eb.ref("excluded.closed_at"),
            content_hash: eb.ref("excluded.content_hash"),
            synced_at: eb.ref("excluded.synced_at"),
          })),
        )
        .returning(["id", "external_id"])
        .execute();
      for (const x of rows) sourceId.set(x.external_id, x.id);
    }

    // Collect only changed messages. Replies write their parents in the same transaction (foreign keys are checked per statement,
    // so parents come first; collect already set replies without a parent to null).
    const live = new Set<string>();
    const conversations = new Map<string, { source: number; external: string; at: string }>();
    const messages: { s: Said; id: string; conversation: string; hash: Buffer; indexed: boolean }[] = [];
    for (const item of items) {
      const source = sourceId.get(String(item.number));
      if (!source) throw new Error(`Could not write PR or issue #${item.number}`);
      const conversation = conversationOf(source, item.number);
      for (const s of said.get(item.number) ?? []) {
        const messageId = uuidFrom(conversation, s.externalId);
        live.add(messageId);
        const hash = sha256(
          JSON.stringify([s.body, s.speaker, s.author?.id ?? null, s.url, s.at, s.replyTo, s.file]),
        );
        if (stored.get(messageId)?.equals(hash)) continue;
        conversations.set(conversation, { source, external: `${repo}#${item.number}`, at: item.createdAt });
        messages.push({ s, id: messageId, conversation, hash, indexed: indexesMessage("github", s.speaker) });
      }
    }
    for (const part of chunks([...conversations]))
      await trx
        .insertInto("conversation")
        .values(
          part.map(([id, v]) => ({
            id,
            project_id: projectId,
            source_item_id: v.source,
            origin: "github",
            external_id: v.external,
            started_at: iso(v.at),
          })),
        )
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    // Write reply parents first (writing a reply before its parent fails the foreign key at the end of that statement).
    const ordered = [...messages].sort((a, b) => Number(a.s.replyTo !== null) - Number(b.s.replyTo !== null));
    for (const part of chunks(ordered))
      await trx
        .insertInto("message")
        .values(
          part.map((m) => ({
            id: m.id,
            conversation_id: m.conversation,
            external_id: m.s.externalId,
            reply_to_id: m.s.replyTo ? uuidFrom(m.conversation, m.s.replyTo) : null,
            speaker_kind: m.s.speaker,
            identity_id: identity(m.s.author),
            body: m.s.body,
            original_bytes: bytes(m.s.body),
            url: m.s.url,
            sent_at: iso(m.s.at),
            content_hash: m.hash,
            indexed: m.indexed ? 1 : 0,
          })),
        )
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({
            reply_to_id: eb.ref("excluded.reply_to_id"),
            speaker_kind: eb.ref("excluded.speaker_kind"),
            identity_id: eb.ref("excluded.identity_id"),
            body: eb.ref("excluded.body"),
            original_bytes: eb.ref("excluded.original_bytes"),
            url: eb.ref("excluded.url"),
            sent_at: eb.ref("excluded.sent_at"),
            content_hash: eb.ref("excluded.content_hash"),
            indexed: eb.ref("excluded.indexed"),
          })),
        )
        .execute();
    for (const part of chunks(messages.map((m) => m.id)))
      await trx.deleteFrom("message_file").where("message_id", "in", part).execute();
    const files = messages.flatMap((m) =>
      m.s.file
        ? [
            {
              message_id: m.id,
              path: m.s.file.path,
              action: "review",
              line_start: m.s.file.startLine ?? m.s.file.line,
              line_end: m.s.file.line ?? m.s.file.startLine,
            },
          ]
        : [],
    );
    for (const part of chunks(files)) await trx.insertInto("message_file").values(part).execute();
    // Delete comments deleted on GitHub. The list is complete (if it could not be fetched, collect threw and this is not reached).
    const gone = [...stored.keys()].filter((id) => !live.has(id));
    let messagesRemoved = 0;
    for (const part of chunks(gone))
      messagesRemoved += Number(
        (await trx.deleteFrom("message").where("id", "in", part).executeTakeFirst()).numDeletedRows,
      );
    // Extract decisions from the bodies of your merged PRs into knowledge (re-evaluated every time, even when the body did not change)
    const decisions = await syncDecisions(
      trx,
      projectId,
      repo,
      items.flatMap((i) => {
        const source = sourceId.get(String(i.number));
        if (i.kind !== "pull_request" || !source) return [];
        const body = (said.get(i.number) ?? []).find((s) => s.externalId === "body");
        return [
          {
            number: i.number,
            merged: i.state === "merged",
            mergedAt: i.closedAt,
            url: i.url,
            sourceItemId: source,
            conversationId: conversationOf(source, i.number),
            body: body?.body ?? null,
            authorId: body?.author?.id ?? null,
          },
        ];
      }),
    );
    // PRs and issues gone from the list (deleted, or moved to another repository) are deleted with their rows.
    const present = new Set(items.map((i) => String(i.number)));
    const vanished = [...known.keys()].filter((n) => !present.has(n));
    let itemsRemoved = 0;
    for (const part of chunks(vanished))
      itemsRemoved += Number(
        (
          await trx
            .deleteFrom("source_item")
            .where("connector_id", "=", connector.id)
            .where("external_id", "in", part)
            .executeTakeFirst()
        ).numDeletedRows,
      );
    await trx
      .updateTable("connector")
      .set({ snapshot_at: snapshotAt, last_success_at: iso(Date.now()), last_error: null })
      .where("id", "=", connector.id)
      .execute();
    return {
      itemsWritten: changedItems.length,
      messagesWritten: messages.length,
      messagesRemoved,
      itemsRemoved,
      decisions,
    };
  });

  if (!counts) return "skipped (another sync stored a newer state after this one started reading)";
  const total = [...said.values()].reduce((n, l) => n + l.length, 0);
  return [
    `${plural(items.length, "PR or issue", "PRs and issues")} (${counts.itemsWritten} rewritten${counts.itemsRemoved ? `, ${counts.itemsRemoved} removed` : ""})`,
    `${plural(total, "message")} (${counts.messagesWritten} rewritten${counts.messagesRemoved ? `, ${counts.messagesRemoved} removed` : ""})`,
    counts.decisions.unlinked
      ? "PR decisions not imported (your GitHub handle is not linked. Run sphica who --me <name> <handle>, then harvest again)"
      : `PR decisions: ${plural(counts.decisions.written, "row")} rewritten${counts.decisions.skipped ? ` (${plural(counts.decisions.skipped, "row")} skipped for not matching the format)` : ""}`,
  ].join(" / ");
}
