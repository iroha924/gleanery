// GitHub の PR・issue を、今の状態（source_item）と会話（conversation / message）にする。
//
// **経路は `gh` の 1 つだけ。**持ち主 1 人なので `gh auth` がそのまま使え、同期先はその PC の DB なので
// どれか 1 台の PC が毎日回せば全 PC から引ける。
//
// PR・issue 1 件が 1 つの会話で、本文・コメント・レビューの指摘がそれぞれ 1 発言になる。
// レビューの返信は reply_to で親を指し、指されたファイルは message_file に置く（「このファイルについて」で引く）。
// **一覧は毎回全部取る。**消えたコメントと PR を反映するには完全な一覧が要り、持ち主のリポジトリなら数秒で済む。
// 書き込みは内容の hash が変わった行だけにする。
// GitHub から来た文字列は全部 clean() を通す（NUL が 1 つあると transaction ごと落ち、毎日の同期が止まる）。

import { execFileSync } from "node:child_process";
import type { Kysely } from "kysely";
import { inTransaction, iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { syncDecisions } from "./decisions.ts";
import { conversationId, indexesMessage, type SpeakerKind } from "./knowledge.ts";
import { connectorOf } from "./project.ts";
import { bytes, clean, sha256, uuidFrom } from "./text.ts";

type User = { id: number; login: string } | null;

export type Pull = {
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

export type RawIssue = {
  number: number;
  title: string;
  body: string | null;
  user: User;
  state: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  /** このキーがあるものは PR。issues エンドポイントは PR も返す */
  pull_request?: unknown;
};

export type ReviewComment = {
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

export type IssueComment = {
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

export const cliSource = (repo: string): GithubSource => ({
  pulls: async () => gh(repo, "pulls?state=all&per_page=100") as Pull[],
  issues: async () => gh(repo, "issues?state=all&per_page=100") as RawIssue[],
  reviewComments: async () => gh(repo, "pulls/comments?per_page=100") as ReviewComment[],
  issueComments: async () => gh(repo, "issues/comments?per_page=100") as IssueComment[],
});

// AI のレビューは中身があるので残す。落とすのは推論を含まない自動通知（Terraform の plan、デプロイ URL、
// カバレッジ表、依存更新）だけ。名前で決めるのは、本文で判定すると書式が変わるたびに漏れるから。
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

// 相槌はナレッジではない。**短さだけで落とさない** — 「これは DBT 側で」は 10 字でも中身がある。
const FILLER =
  /^(lgtm|ok(です)?|了解(です)?|確認しました|ありがとうございます?|修正しました|対応しました|なるほど|承知(しました)?|わかりました|👍|:\+1:|:eyes:|:pray:)[!！。.\s]*$/i;
export const isFiller = (body: string): boolean => {
  const t = body.trim();
  return t.length === 0 || FILLER.test(t) || /^!?\[[^\]]*\]\([^)]*\)$/.test(t);
};

export type Item = {
  kind: "pull_request" | "issue";
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  url: string;
  author: User;
  createdAt: string;
  updatedAt: string;
  /** マージした（PR）か閉じた時刻。開いているものは null */
  closedAt: string | null;
};

export type Said = {
  /** 会話の中で一意。本文は `body`、コメントは `c:<id>`、レビューは `r:<id>` */
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

/** PR と issue の本体、コメント、レビューを集めて、書き込む形へ揃える。 */
export async function collect(source: GithubSource): Promise<Collected> {
  const items = new Map<number, Item>();
  // ページ送りの最中に新しい PR やコメントが入ると、境界の項目が 2 ページに現れる。同じ発言は 1 つにする
  // （まとめて書く upsert に同じ id が 2 行あると、transaction ごと落ちる）。
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
    // **bot が作った PR も入れる。**リリース PR は release-bot 名義で、落とすと「いつ何を出したか」が消える。
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
    // issues エンドポイントは PR も返す。**bot が作った issue は入れない**（定期レポートが並ぶだけになる）。
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
  // 返信の親が落とされた（相槌だった）ときは、親を持たない発言として残す。
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

// 1 文で渡す変数の数を SQLite の上限（32,766）より十分下に保つ。
const chunks = <T>(xs: T[], n = 1000): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/**
 * 1 つのプロジェクトの GitHub を同期する。repo は `owner/name`。
 * **読み始めた時刻が、既に入っている snapshot より古ければ書かない**（遅れて commit した同期が新しい状態を巻き戻さない）。
 */
export async function syncGithub(db: Kysely<DB>, projectId: number, repo: string): Promise<string> {
  // 読み始めた時刻。同じ PC の同期どうしを比べるので、この PC の時計で足りる（DB は PC ごとに独立している）。
  const snapshotAt = iso(Date.now());
  const { items, said } = await collect(cliSource(repo));

  const counts = await inTransaction(db, async (trx) => {
    const connector = await connectorOf(trx, projectId, "github");
    // 取得を始めた後に、別の同期がより新しい取得を入れていれば書かない（遅れた古い取得で巻き戻さない）。
    if (connector.snapshotAt && snapshotAt < connector.snapshotAt) return null;

    // 発言者。login は変えられるので user id で結び、handle は今の login に揃える。
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
    // 既に入っている発言を 1 回で読む。変わっていない PR・issue では 1 往復もしない。
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

    // 変わった発言だけを集める。返信は同じ transaction で親を書く（外部キーは文ごとに確かめられるので、
    // 親を先に並べる。親が無い返信は collect が null にしてある）。
    const live = new Set<string>();
    const conversations = new Map<string, { source: number; external: string; at: string }>();
    const messages: { s: Said; id: string; conversation: string; hash: Buffer; indexed: boolean }[] = [];
    for (const item of items) {
      const source = sourceId.get(String(item.number));
      if (!source) throw new Error(`PR・issue を書けなかった: #${item.number}`);
      const conversation = conversationId(projectId, "github", `${repo}#${item.number}`);
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
    // 返信の親を先に書く（親の無い返信を先に書くと、外部キーがその文の終わりで落ちる）。
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
    // GitHub で消されたコメントは消す。一覧は完全なもの（取れなかったら collect が投げてここに来ない）。
    const gone = [...stored.keys()].filter((id) => !live.has(id));
    let messagesRemoved = 0;
    for (const part of chunks(gone))
      messagesRemoved += Number(
        (await trx.deleteFrom("message").where("id", "in", part).executeTakeFirst()).numDeletedRows,
      );
    // merge した持ち主の PR の本文から、判断を取り出して knowledge に揃える（本文が変わっていなくても毎回判定し直す）
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
            conversationId: conversationId(projectId, "github", `${repo}#${i.number}`),
            body: body?.body ?? null,
            authorId: body?.author?.id ?? null,
          },
        ];
      }),
    );
    // 一覧から消えた PR・issue（削除された、別のリポジトリへ移された）は行ごと消す。
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

  if (!counts) return "飛ばした（読み始めた後に、別の同期がより新しい状態を入れた）";
  const total = [...said.values()].reduce((n, l) => n + l.length, 0);
  return [
    `PR・issue ${items.length} 件（書き直した ${counts.itemsWritten} 件${counts.itemsRemoved ? ` / 消えた ${counts.itemsRemoved} 件` : ""}）`,
    `発言 ${total} 件（書き直した ${counts.messagesWritten} 件${counts.messagesRemoved ? ` / 消えた ${counts.messagesRemoved} 件` : ""}）`,
    counts.decisions.unlinked
      ? "PR の判断は取り込んでいない（持ち主の GitHub のハンドルを結んでいない。gleanery who --me <呼び名> <ハンドル> の後にもう一度 harvest）"
      : `PR の判断 書き直した行 ${counts.decisions.written}${counts.decisions.skipped ? `（書式に合わず飛ばした行 ${counts.decisions.skipped}）` : ""}`,
  ].join(" / ");
}
