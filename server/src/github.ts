// GitHub の PR・issue を、今の状態（source_item）と会話（conversation / message）にする。
//
// **経路は `gh` の 1 つだけ。**持ち主 1 人なので `gh auth` がそのまま使え、同期先はその PC の DB なので
// どれか 1 台の PC が毎日回せば全 PC から引ける。
//
// PR・issue 1 件が 1 つの会話で、本文・コメント・レビューの指摘がそれぞれ 1 発言になる。
// レビューの返信は reply_to で親を指し、指されたファイルは message_file に置く（「このファイルについて」で引く）。
// **一覧は毎回全部取る。**消えたコメントと PR を反映するには完全な一覧が要り、持ち主のリポジトリなら数秒で済む。
// 書き込みは内容の hash が変わった行だけにし、表ごとに 1 往復でまとめて書く（往復は件数に比例して効く）。
// GitHub から来た文字列は全部 clean() を通す（NUL が 1 つあると transaction ごと落ち、毎日の同期が止まる）。

import { execFileSync } from "node:child_process";
import type pg from "pg";
import { EMBED_MODEL, inClientTransaction } from "./db.ts";
import { conversationId, indexesMessage, messageText, type SpeakerKind } from "./knowledge.ts";
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

/**
 * 1 つの作業場所の GitHub を同期する。repo は `owner/name`。
 * **読み始めた時刻が、既に入っている snapshot より古ければ書かない**（遅れて commit した同期が新しい状態を巻き戻さない）。
 */
export async function syncGithub(
  client: pg.Client,
  projectId: number,
  projectName: string,
  repo: string,
): Promise<string> {
  // snapshot の時刻は DB の時計で取る。PC の時計が進んでいると、その差の分だけ他の PC の同期が止まる。
  const snapshotAt = (await client.query<{ now: Date }>("select now()")).rows[0]?.now;
  if (!snapshotAt) throw new Error("DB の時刻を取れなかった");
  const { items, said } = await collect(cliSource(repo));

  const counts = await inClientTransaction(client, async () => {
    const connector = await connectorOf(client, projectId, "github");
    // 取得を始めた後に、別の同期がより新しい取得を入れていれば書かない（遅れた古い取得で巻き戻さない）。
    if (connector.snapshotAt && snapshotAt.getTime() < connector.snapshotAt.getTime()) return null;

    // 発言者。login は変えられるので user id で結び、handle は今の login に揃える。
    const users = new Map<number, string>();
    for (const i of items) if (i.author) users.set(i.author.id, i.author.login);
    for (const list of said.values())
      for (const s of list) if (s.author) users.set(s.author.id, s.author.login);
    const ids = new Map<number, string>();
    if (users.size) {
      await client.query(
        `insert into gleanery.person_identity (provider, external_id, handle)
         select 'github', t.id, t.handle from unnest($1::text[], $2::text[]) as t(id, handle)
         on conflict (provider, external_id) do update set handle = excluded.handle
           where gleanery.person_identity.handle <> excluded.handle`,
        [[...users.keys()].map(String), [...users.values()]],
      );
      const all = await client.query<{ id: string; external_id: string }>(
        "select id, external_id from gleanery.person_identity where provider = 'github' and external_id = any($1)",
        [[...users.keys()].map(String)],
      );
      for (const x of all.rows) ids.set(Number(x.external_id), x.id);
    }
    const identity = (u: User) => (u ? (ids.get(u.id) ?? null) : null);

    const known = new Map(
      (
        await client.query<{ id: string; external_id: string; content_hash: Buffer }>(
          "select id, external_id, content_hash from gleanery.source_item where connector_id = $1",
          [connector.id],
        )
      ).rows.map((r) => [r.external_id, r]),
    );
    // 既に入っている発言を 1 回で読む。変わっていない PR・issue では 1 往復もしない。
    const stored = new Map(
      (
        await client.query<{ id: string; content_hash: Buffer }>(
          `select m.id, m.content_hash from gleanery.message m
           join gleanery.conversation c on c.id = m.conversation_id
           join gleanery.source_item s on s.id = c.source_item_id
           where s.connector_id = $1`,
          [connector.id],
        )
      ).rows.map((r) => [r.id, r.content_hash]),
    );

    const sourceId = new Map([...known].map(([n, r]) => [n, r.id]));
    const changedItems = items.filter((i) => !known.get(String(i.number))?.content_hash.equals(itemHash(i)));
    if (changedItems.length) {
      const r = await client.query<{ id: string; external_id: string }>(
        `insert into gleanery.source_item (connector_id, external_id, kind, title, state, url, author_identity_id,
                                        source_created_at, source_updated_at, closed_at, content_hash, synced_at)
         select $1, t.number, t.kind, t.title, t.state, t.url, t.author, t.created, t.updated, t.closed,
                decode(t.hash, 'hex'), now()
         from jsonb_to_recordset($2::jsonb) as t(number text, kind text, title text, state text, url text,
                                                 author bigint, created timestamptz, updated timestamptz,
                                                 closed timestamptz, hash text)
         on conflict (connector_id, external_id) do update set
           kind = excluded.kind, title = excluded.title, state = excluded.state, url = excluded.url,
           author_identity_id = excluded.author_identity_id, source_created_at = excluded.source_created_at,
           source_updated_at = excluded.source_updated_at, closed_at = excluded.closed_at,
           content_hash = excluded.content_hash, synced_at = now()
         returning id, external_id`,
        [
          connector.id,
          JSON.stringify(
            changedItems.map((i) => ({
              number: String(i.number),
              kind: i.kind,
              title: i.title,
              state: i.state,
              url: i.url,
              author: identity(i.author),
              created: i.createdAt,
              updated: i.updatedAt,
              closed: i.closedAt,
              hash: itemHash(i).toString("hex"),
            })),
          ),
        ],
      );
      for (const x of r.rows) sourceId.set(x.external_id, x.id);
    }

    // 変わった発言だけを集める。返信は同じ文で親を書くので順は問わない（外部キーは文の終わりで確かめられる）。
    const live = new Set<string>();
    const conversations = new Map<string, { source: string; external: string; at: string }>();
    const messages = [];
    for (const item of items) {
      const source = sourceId.get(String(item.number));
      if (!source) throw new Error(`PR・issue を書けなかった: #${item.number}`);
      const conversation = conversationId(projectId, "github", `${repo}#${item.number}`);
      for (const s of said.get(item.number) ?? []) {
        const messageId = uuidFrom(conversation, s.externalId);
        live.add(messageId);
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
        conversations.set(conversation, { source, external: `${repo}#${item.number}`, at: item.createdAt });
        const indexed = indexesMessage("github", s.speaker);
        messages.push({
          s,
          indexed,
          embedText,
          json: {
            id: messageId,
            conversation,
            external: s.externalId,
            reply: s.replyTo ? uuidFrom(conversation, s.replyTo) : null,
            speaker: s.speaker,
            identity: identity(s.author),
            body: s.body,
            url: s.url,
            at: s.at,
            hash: hash.toString("hex"),
            lex: indexed ? tsvector(`${item.title}\n${s.file?.path ?? ""}\n${s.body}`) : null,
          },
        });
      }
    }
    if (conversations.size) {
      const c = [...conversations];
      await client.query(
        `insert into gleanery.conversation (id, project_id, source_item_id, origin, external_id, started_at)
         select t.id, $1, t.source, 'github', t.external, t.at
         from unnest($2::uuid[], $3::bigint[], $4::text[], $5::timestamptz[]) as t(id, source, external, at)
         on conflict (id) do nothing`,
        [
          projectId,
          c.map(([id]) => id),
          c.map(([, v]) => v.source),
          c.map(([, v]) => v.external),
          c.map(([, v]) => v.at),
        ],
      );
    }
    if (messages.length) {
      await client.query(
        `insert into gleanery.message (id, conversation_id, external_id, reply_to_id, speaker_kind, identity_id, body,
                                    original_bytes, url, sent_at, content_hash, lexemes)
         select t.id, t.conversation, t.external, t.reply, t.speaker, t.identity, t.body, octet_length(t.body), t.url,
                t.at, decode(t.hash, 'hex'), t.lex::tsvector
         from jsonb_to_recordset($1::jsonb) as t(id uuid, conversation uuid, external text, reply uuid, speaker text,
                                                 identity bigint, body text, url text, at timestamptz, hash text,
                                                 lex text)
         on conflict (id) do update set
           reply_to_id = excluded.reply_to_id, speaker_kind = excluded.speaker_kind,
           identity_id = excluded.identity_id, body = excluded.body, original_bytes = excluded.original_bytes,
           url = excluded.url, sent_at = excluded.sent_at, content_hash = excluded.content_hash,
           lexemes = excluded.lexemes`,
        [JSON.stringify(messages.map((m) => m.json))],
      );
      const written = messages.map((m) => m.json.id);
      await client.query("delete from gleanery.message_file where message_id = any($1::uuid[])", [written]);
      const files = messages.flatMap((m) => (m.s.file ? [{ id: m.json.id, ...m.s.file }] : []));
      if (files.length) {
        await client.query(
          `insert into gleanery.message_file (message_id, path, action, line_start, line_end)
           select t.id, t.path, 'review', t.first, t.last
           from unnest($1::uuid[], $2::text[], $3::int[], $4::int[]) as t(id, path, first, last)`,
          [
            files.map((f) => f.id),
            files.map((f) => f.path),
            files.map((f) => f.startLine ?? f.line),
            files.map((f) => f.line ?? f.startLine),
          ],
        );
      }
      const embed = messages.filter((m) => m.indexed);
      if (embed.length) {
        await client.query(
          `insert into gleanery.message_embedding (message_id, model, source_hash, status)
           select t.id, $3, t.hash, 'pending' from unnest($1::uuid[], $2::bytea[]) as t(id, hash)
           on conflict (message_id) do update set
             source_hash = excluded.source_hash, status = 'pending', embedding = null, attempts = 0,
             last_error = null, updated_at = now()
           where gleanery.message_embedding.source_hash <> excluded.source_hash`,
          [embed.map((m) => m.json.id), embed.map((m) => sha256(m.embedText)), EMBED_MODEL],
        );
      }
    }
    // GitHub で消されたコメントは消す。一覧は完全なもの（取れなかったら collect が投げてここに来ない）。
    const gone = [...stored.keys()].filter((id) => !live.has(id));
    const messagesRemoved = gone.length
      ? ((await client.query("delete from gleanery.message where id = any($1::uuid[])", [gone])).rowCount ??
        0)
      : 0;
    // 一覧から消えた PR・issue（削除された、別のリポジトリへ移された）は行ごと消す。
    const removed = await client.query(
      "delete from gleanery.source_item where connector_id = $1 and not (external_id = any($2))",
      [connector.id, items.map((i) => String(i.number))],
    );
    await client.query(
      "update gleanery.connector set snapshot_at = $2, last_success_at = now(), last_error = null where id = $1",
      [connector.id, snapshotAt],
    );
    return {
      itemsWritten: changedItems.length,
      messagesWritten: messages.length,
      messagesRemoved,
      itemsRemoved: removed.rowCount ?? 0,
    };
  });

  if (!counts) return "飛ばした（読み始めた後に、別の同期がより新しい状態を入れた）";
  const total = [...said.values()].reduce((n, l) => n + l.length, 0);
  return [
    `PR・issue ${items.length} 件（書き直した ${counts.itemsWritten} 件${counts.itemsRemoved ? ` / 消えた ${counts.itemsRemoved} 件` : ""}）`,
    `発言 ${total} 件（書き直した ${counts.messagesWritten} 件${counts.messagesRemoved ? ` / 消えた ${counts.messagesRemoved} 件` : ""}）`,
  ].join(" / ");
}
