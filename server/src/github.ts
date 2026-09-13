// GitHub の PR・issue を、今の状態（source_item）と会話（conversation / message）にする。
//
// **経路は `gh` の 1 つだけ。**持ち主 1 人なので `gh auth` がそのまま使え、同期先は Neon なので
// どれか 1 台の PC が毎日回せば全 PC から引ける。
//
// PR・issue 1 件が 1 つの会話で、本文・コメント・レビューの指摘がそれぞれ 1 発言になる。
// レビューの返信は reply_to で親を指し、指されたファイルは message_file に置く（「このファイルについて」で引く）。
// **一覧は毎回全部取る。**消えたコメントと PR を反映するには完全な一覧が要り、持ち主のリポジトリなら数秒で済む。
// 書き込みは内容の hash が変わった行だけにする。

import { execFileSync } from "node:child_process";
import type pg from "pg";
import { EMBED_MODEL, type Env, inTransaction } from "./db.ts";
import { fillMessages } from "./embeddings.ts";
import { conversationId, indexesMessage, messageText } from "./knowledge.ts";
import { connectorOf } from "./project.ts";
import { clean, sha256, tsvector, uuidFrom } from "./text.ts";

type User = { id: number; login: string } | null;

export type Pull = {
  number: number;
  title: string;
  body: string | null;
  user: User;
  state: string;
  merged_at: string | null;
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
  created_at: string;
  updated_at: string;
  html_url: string;
  /** この鍵があるものは PR。issues エンドポイントは PR も返す */
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

export type Speaker = "person" | "assistant" | "bot";
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
  const said = new Map<number, Said[]>();
  const push = (n: number, s: Said) => said.set(n, [...(said.get(n) ?? []), s]);
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
    items.set(p.number, {
      kind: "pull_request",
      number: p.number,
      title: p.title,
      state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
      url: p.html_url,
      author: p.user,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    });
    body(p.number, p.user, p.body, p.created_at, p.html_url);
  }
  for (const i of await source.issues()) {
    // issues エンドポイントは PR も返す。**bot が作った issue は入れない**（定期レポートが並ぶだけになる）。
    if (i.pull_request || speakerOf(i.user?.login ?? "") === "bot") continue;
    items.set(i.number, {
      kind: "issue",
      number: i.number,
      title: i.title,
      state: i.state === "open" ? "open" : "closed",
      url: i.html_url,
      author: i.user,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    });
    body(i.number, i.user, i.body, i.created_at, i.html_url);
  }

  const keep = (author: User, text: string) =>
    Boolean(author) && speakerOf(author?.login ?? "") !== "bot" && !isFiller(text);
  for (const r of await source.reviewComments()) {
    const n = Number(r.pull_request_url.split("/").pop());
    if (!items.has(n) || !keep(r.user, r.body)) continue;
    push(n, {
      externalId: `r:${r.id}`,
      replyTo: r.in_reply_to_id ? `r:${r.in_reply_to_id}` : null,
      author: r.user,
      speaker: speakerOf(r.user?.login ?? ""),
      body: clean(r.body).trim(),
      url: r.html_url,
      at: r.created_at,
      file: { path: r.path, line: r.line ?? null, startLine: r.start_line ?? null },
    });
  }
  for (const c of await source.issueComments()) {
    const n = Number(c.issue_url.split("/").pop());
    if (!items.has(n) || !keep(c.user, c.body)) continue;
    push(n, {
      externalId: `c:${c.id}`,
      replyTo: null,
      author: c.user,
      speaker: speakerOf(c.user?.login ?? ""),
      body: clean(c.body).trim(),
      url: c.html_url,
      at: c.created_at,
      file: null,
    });
  }
  // 返信の親が落とされた（相槌だった）ときは、親を持たない発言として残す。
  for (const list of said.values()) {
    const ids = new Set(list.map((s) => s.externalId));
    for (const s of list) if (s.replyTo && !ids.has(s.replyTo)) s.replyTo = null;
  }
  return { items: [...items.values()], said };
}

const itemHash = (i: Item): Buffer =>
  sha256(JSON.stringify([i.kind, i.title, i.state, i.url, i.author?.id ?? null, i.createdAt, i.updatedAt]));

/** 1 つの作業場所の GitHub を同期する。repo は `owner/name`。 */
export async function syncGithub(
  client: pg.Client,
  env: Env,
  projectId: number,
  projectName: string,
  repo: string,
  source: GithubSource = cliSource(repo),
  say: (m: string) => void = () => {},
): Promise<string> {
  const { items, said } = await collect(source);
  say(`PR・issue ${items.length} 件を集めた`);

  const counts = await inTransaction(client, async () => {
    const connectorId = await connectorOf(client, projectId, "github");

    // 発言者。login は変えられるので user id で結び、handle は今の login に揃える。
    const users = new Map<number, string>();
    for (const i of items) if (i.author) users.set(i.author.id, i.author.login);
    for (const list of said.values())
      for (const s of list) if (s.author) users.set(s.author.id, s.author.login);
    const ids = new Map<number, string>();
    if (users.size) {
      await client.query(
        `insert into mitos.person_identity (provider, external_id, handle)
         select 'github', t.id, t.handle from unnest($1::text[], $2::text[]) as t(id, handle)
         on conflict (provider, external_id) do update set handle = excluded.handle
           where mitos.person_identity.handle <> excluded.handle`,
        [[...users.keys()].map(String), [...users.values()]],
      );
      const all = await client.query<{ id: string; external_id: string }>(
        "select id, external_id from mitos.person_identity where provider = 'github' and external_id = any($1)",
        [[...users.keys()].map(String)],
      );
      for (const x of all.rows) ids.set(Number(x.external_id), x.id);
    }
    const identity = (u: User) => (u ? (ids.get(u.id) ?? null) : null);

    const known = new Map(
      (
        await client.query<{ id: string; external_id: string; content_hash: Buffer }>(
          "select id, external_id, content_hash from mitos.source_item where connector_id = $1",
          [connectorId],
        )
      ).rows.map((r) => [r.external_id, r]),
    );
    // 既に入っている発言を 1 回で読む。変わっていない PR・issue では 1 往復もしない。
    const stored = new Map(
      (
        await client.query<{ id: string; content_hash: Buffer }>(
          `select m.id, m.content_hash from mitos.message m
           join mitos.conversation c on c.id = m.conversation_id
           join mitos.source_item s on s.id = c.source_item_id
           where s.connector_id = $1`,
          [connectorId],
        )
      ).rows.map((r) => [r.id, r.content_hash]),
    );
    const live = new Set<string>();

    let itemsWritten = 0;
    let messagesWritten = 0;
    let messagesRemoved = 0;
    for (const item of items) {
      const hash = itemHash(item);
      let sourceId = known.get(String(item.number))?.id;
      if (!sourceId || !known.get(String(item.number))?.content_hash.equals(hash)) {
        const r = await client.query<{ id: string }>(
          `insert into mitos.source_item (connector_id, external_id, kind, title, state, url, author_identity_id,
                                          source_created_at, source_updated_at, content_hash, synced_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           on conflict (connector_id, external_id) do update set
             kind = excluded.kind, title = excluded.title, state = excluded.state, url = excluded.url,
             author_identity_id = excluded.author_identity_id, source_created_at = excluded.source_created_at,
             source_updated_at = excluded.source_updated_at, content_hash = excluded.content_hash, synced_at = now()
           returning id`,
          [
            connectorId,
            String(item.number),
            item.kind,
            item.title,
            item.state,
            item.url,
            identity(item.author),
            item.createdAt,
            item.updatedAt,
            hash,
          ],
        );
        sourceId = r.rows[0]?.id;
        itemsWritten++;
      }
      if (!sourceId) throw new Error(`PR・issue を書けなかった: #${item.number}`);

      const conversation = conversationId(projectId, "github", `${repo}#${item.number}`);
      const list = said.get(item.number) ?? [];
      let opened = false;
      // 返信は親より後に書く（reply_to の外部キー）。GitHub の返信は親より新しいので、時刻順で足りる。
      const ordered = [...list].sort((a, b) => a.at.localeCompare(b.at));
      for (const s of ordered) {
        const messageId = uuidFrom(conversation, s.externalId);
        live.add(messageId);
        const replyTo = s.replyTo ? uuidFrom(conversation, s.replyTo) : null;
        const indexed = indexesMessage("github", s.speaker);
        const embedText = messageText({
          body: s.body,
          speakerKind: s.speaker,
          handle: s.author?.login ?? null,
          project: projectName,
          source: { kind: item.kind, number: String(item.number), title: item.title },
          paths: s.file ? [s.file.path] : [],
        });
        const hash = sha256(
          JSON.stringify([
            s.body,
            s.speaker,
            s.author?.id ?? null,
            s.url,
            s.at,
            s.replyTo,
            s.file,
            embedText,
          ]),
        );
        if (stored.get(messageId)?.equals(hash)) continue;
        if (!opened) {
          await client.query(
            `insert into mitos.conversation (id, project_id, source_item_id, origin, external_id, started_at)
             values ($1, $2, $3, 'github', $4, $5) on conflict (id) do nothing`,
            [conversation, projectId, sourceId, `${repo}#${item.number}`, item.createdAt],
          );
          opened = true;
        }
        await client.query(
          `insert into mitos.message (id, conversation_id, external_id, reply_to_id, speaker_kind, identity_id, body,
                                      original_bytes, url, sent_at, content_hash, lexemes)
           values ($1, $2, $3, $4, $5, $6, $7, octet_length($7), $8, $9, $10, $11::tsvector)
           on conflict (id) do update set
             reply_to_id = excluded.reply_to_id, speaker_kind = excluded.speaker_kind,
             identity_id = excluded.identity_id, body = excluded.body, original_bytes = excluded.original_bytes,
             url = excluded.url, sent_at = excluded.sent_at, content_hash = excluded.content_hash,
             lexemes = excluded.lexemes`,
          [
            messageId,
            conversation,
            s.externalId,
            replyTo,
            s.speaker,
            identity(s.author),
            s.body,
            s.url,
            s.at,
            hash,
            indexed ? tsvector(`${item.title}\n${s.file?.path ?? ""}\n${s.body}`) : null,
          ],
        );
        await client.query("delete from mitos.message_file where message_id = $1", [messageId]);
        if (s.file) {
          await client.query(
            `insert into mitos.message_file (message_id, path, action, line_start, line_end)
             values ($1, $2, 'review', $3, $4)`,
            [messageId, s.file.path, s.file.startLine ?? s.file.line, s.file.line ?? s.file.startLine],
          );
        }
        if (indexed) {
          await client.query(
            `insert into mitos.message_embedding (message_id, model, source_hash, status) values ($1, $2, $3, 'pending')
             on conflict (message_id) do update set
               source_hash = excluded.source_hash, status = 'pending', embedding = null, attempts = 0,
               last_error = null, updated_at = now()
             where mitos.message_embedding.source_hash <> excluded.source_hash`,
            [messageId, EMBED_MODEL, sha256(embedText)],
          );
        }
        messagesWritten++;
      }
    }
    // GitHub で消されたコメントは消す。一覧は完全なもの（取れなかったら collect が投げてここに来ない）。
    const gone = [...stored.keys()].filter((id) => !live.has(id));
    if (gone.length) {
      const r = await client.query("delete from mitos.message where id = any($1::uuid[])", [gone]);
      messagesRemoved = r.rowCount ?? 0;
    }
    // 一覧から消えた PR・issue（削除された、別のリポジトリへ移された）は行ごと消す。
    const removed = await client.query(
      "delete from mitos.source_item where connector_id = $1 and not (external_id = any($2))",
      [connectorId, items.map((i) => String(i.number))],
    );
    await client.query(
      "update mitos.connector set last_success_at = now(), last_error = null where id = $1",
      [connectorId],
    );
    return { itemsWritten, messagesWritten, messagesRemoved, itemsRemoved: removed.rowCount ?? 0 };
  });

  const filled = await fillMessages(client, env);
  const total = [...said.values()].reduce((n, l) => n + l.length, 0);
  return [
    `PR・issue ${items.length} 件（書き直した ${counts.itemsWritten} 件${counts.itemsRemoved ? ` / 消えた ${counts.itemsRemoved} 件` : ""}）`,
    `発言 ${total} 件（書き直した ${counts.messagesWritten} 件${counts.messagesRemoved ? ` / 消えた ${counts.messagesRemoved} 件` : ""}）`,
    `埋め込み ${filled.embedded} 件${filled.failed ? `（失敗 ${filled.failed} 件。次の同期で取り直す）` : ""}`,
  ].join(" / ");
}
