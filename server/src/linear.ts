// Linear の issue をナレッジにする。
//
// **課題管理はプロジェクトごとに違う**（GitHub / Linear / Jira）。ここは Linear だけを見る。
// どの束が Linear なのかはこのファイルは知らない。束に足された tracker の作業場所が決める。
//
// 取得経路が github.ts と違う。**macbee planet は Linear の API キー発行を組織で止めている**ので、
// GraphQL を直接叩けない。使えるのは OAuth 済みの Linear MCP だけで、それは Claude Code の
// 中にしか無い。だから `claude -p` をヘッドレスで回して MCP を叩く。
//
// **LLM に本文を書き写させない。**`--output-format stream-json` はツール結果を生のまま流すので、
// そこから拾えば MCP の応答がそのまま手に入る。Claude がやるのは「どのツールをどの引数で呼ぶか」
// だけで、issue の本文もコメントも LLM を通らない。書き写させると必ず要約と脱落が混ざる。
//
// **ページ送りも LLM に任せない。**カーソルは呼び出し側が生の結果から読み、次の実行へ引数として
// 渡す。任せると「だいたい全部取った」で止まる余地が残り、コメントの取りこぼしはそのまま
// 「その話は記録に無い」に化ける。
//
// 実測（2026-09-06、Onetag チーム）:
//   list_issues  … description が切り詰められて返る（`(truncated, use get_issue ...)`）
//   get_issue    … 全文が返る
//   list_comments… 切り詰めなし。parentId でスレッドが辿れる
// なので列挙は list_issues、本文は get_issue、コメントは list_comments と役割を分ける。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { actorKind, isNoise } from "./actor.ts";
import { EMBED_MODEL, type Env, embed, vec } from "./db.ts";

// --- MCP を叩く ---

// 設定はここで書き出す。**特定のディレクトリの .claude 設定に依存させない**
// （実測: プロジェクト scope に置くと、そのディレクトリからしか届かなかった）。
// OAuth のトークンは URL 単位でマシンに保存されているので、設定さえ渡せばどこからでも通る。
function mcpConfigPath(): string {
  const p = path.join(os.tmpdir(), "mitos-linear-mcp.json");
  fs.writeFileSync(
    p,
    JSON.stringify({ mcpServers: { "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" } } }),
  );
  return p;
}

type Called = { name: string; text: string };

/**
 * `claude -p` を 1 回回し、MCP のツール結果を**生のまま**順番に返す。
 * 返るのは linear-server のものだけ（ToolSearch などは落とす）。
 */
function runClaude(prompt: string, tools: string[]): Called[] {
  const out = execFileSync(
    "claude",
    [
      "-p",
      prompt,
      "--mcp-config",
      mcpConfigPath(),
      "--allowedTools",
      tools.join(","),
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );

  // tool_result は名前を持たない。直前の tool_use と id で突き合わせる。
  const names = new Map<string, string>();
  const results: Called[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let m: { message?: { content?: unknown } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        names.set(b.id, b.name);
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const name = names.get(b.tool_use_id) ?? "";
        if (!name.startsWith("mcp__linear-server__")) continue;
        results.push({ name, text: resultText(b.content) });
      }
    }
  }
  return results;
}

/**
 * ツール結果の本文を取り出す。
 *
 * **大きい結果はファイルへ退避される。**実測: コメントの多い issue で
 * `Error: result (58,461 characters ...) exceeds maximum allowed tokens.
 *  Output has been saved to <path>` が返り、content が配列ではなく文字列になった。
 * この形を知らないと本文が空になり、**コメントが黙って 0 件で取り込まれる。**
 * 退避先を読めば全文が手に入るので、そこから読む（LLM を通らないのは同じ）。
 */
export function resultText(content: unknown): string {
  const raw = Array.isArray(content)
    ? (content as Record<string, unknown>[]).map((x) => (typeof x.text === "string" ? x.text : "")).join("")
    : typeof content === "string"
      ? content
      : "";
  // 退避先の直後に句点が付く（`....txt.\nFormat: Plain text`）。**貪欲に取ると存在しないパスになる。**
  const saved = raw.match(/Output has been saved to (\S+?\.txt)/);
  const file = saved?.[1];
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  return raw;
}

/**
 * ツールを 1 回だけ、指定した引数で呼ばせて結果を返す。
 * **引数を文章で説明せず JSON でそのまま渡す。**言い換えさせると引数が変わる。
 */
function callOnce(tool: string, args: Record<string, unknown>): unknown {
  const short = tool.replace("mcp__linear-server__", "");
  const got = runClaude(
    `mcp__linear-server__${short} を次の引数でちょうど 1 回だけ呼べ。引数は一字も変えるな。結果は出力しなくていい。\n${JSON.stringify(args)}`,
    [`mcp__linear-server__${short}`],
  );
  const hit = got.find((r) => r.name === `mcp__linear-server__${short}`);
  if (!hit) throw new Error(`${short} が呼ばれなかった（Linear MCP に届いていない可能性）`);
  try {
    return JSON.parse(hit.text);
  } catch {
    // **黙って空で進めない。**取りこぼしは「その話は記録に無い」に化けるので、ここで止める。
    throw new Error(`${short} の応答を JSON として読めなかった: ${hit.text.slice(0, 200)}`);
  }
}

/** hasNextPage / cursor を見て打ち止めまで辿る。**取りこぼしを起こさないのはここ。** */
function* pages(tool: string, args: Record<string, unknown>): Generator<Record<string, unknown>> {
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = callOnce(tool, cursor ? { ...args, cursor } : args) as Record<string, unknown>;
    yield page;
    if (page.hasNextPage !== true || typeof page.cursor !== "string") return;
    cursor = page.cursor;
  }
  throw new Error(`${tool} のページ送りが 500 回で終わらなかった`);
}

// --- 取ってきたものの形 ---

export type Comment = { id: string; parentId: string | null; author: string; body: string; at: string };

export type Issue = {
  /** OT-4550 */
  id: string;
  title: string;
  description: string;
  url: string;
  status: string;
  statusType: string;
  project: string | null;
  labels: string[];
  createdBy: string;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
};

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? (o[k] as string) : "";
const strOrNull = (o: Record<string, unknown>, k: string): string | null =>
  typeof o[k] === "string" && o[k] ? (o[k] as string) : null;

/** 自分が Linear で何という名前なのか。関わっている issue を選ぶのに要る。 */
export function whoAmI(): string {
  const me = callOnce("get_user", { query: "me" }) as Record<string, unknown>;
  const name = str(me, "name");
  if (!name) throw new Error("Linear の自分の名前が取れなかった");
  return name;
}

/** 列挙だけに使う形。**本文は切り詰められて返るのでここには入れない。** */
export type Brief = {
  id: string;
  url: string;
  updatedAt: string;
  assignee: string | null;
  createdBy: string | null;
};

/** チーム内の issue を列挙する。本文は get_issue で取り直す。 */
export function listIssues(team: string): Brief[] {
  const out: Brief[] = [];
  for (const page of pages("list_issues", {
    team,
    limit: 250,
    orderBy: "updatedAt",
    includeArchived: true,
    fields: [
      "id",
      "title",
      "url",
      "status",
      "statusType",
      "createdAt",
      "updatedAt",
      "project",
      "assignee",
      "createdBy",
    ],
  })) {
    for (const r of (Array.isArray(page.issues) ? page.issues : []) as Record<string, unknown>[]) {
      out.push({
        id: str(r, "id"),
        url: str(r, "url"),
        updatedAt: str(r, "updatedAt"),
        assignee: strOrNull(r, "assignee"),
        createdBy: strOrNull(r, "createdBy"),
      });
    }
  }
  return out;
}

/** 1 件の全文とコメント全部。**コメントは打ち止めまで辿る。** */
export function fetchIssue(id: string): Issue {
  const d = callOnce("get_issue", { id }) as Record<string, unknown>;
  const comments: Comment[] = [];
  for (const page of pages("list_comments", { issueId: id, limit: 250, orderBy: "createdAt" })) {
    for (const c of (Array.isArray(page.comments) ? page.comments : []) as Record<string, unknown>[]) {
      const author = c.author as Record<string, unknown> | undefined;
      comments.push({
        id: str(c, "id"),
        parentId: strOrNull(c, "parentId"),
        author: author ? str(author, "name") : "unknown",
        body: str(c, "body").trim(),
        at: str(c, "createdAt"),
      });
    }
  }
  comments.sort((a, b) => a.at.localeCompare(b.at));
  const labels = Array.isArray(d.labels) ? d.labels : [];
  return {
    id: str(d, "id") || id,
    title: str(d, "title"),
    description: str(d, "description"),
    url: str(d, "url"),
    status: str(d, "status"),
    statusType: str(d, "statusType"),
    project: strOrNull(d, "project"),
    labels: labels
      .map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>)?.name ?? "")))
      .filter(Boolean),
    createdBy: str(d, "createdBy") || "unknown",
    assignee: strOrNull(d, "assignee"),
    createdAt: str(d, "createdAt"),
    updatedAt: str(d, "updatedAt"),
    comments,
  };
}

// --- ナレッジの形にする ---

/** 相槌はナレッジではない。**短さだけで落とさない** — 「DBT 側で」は 6 字でも中身がある。 */
const FILLER =
  /^(lgtm|ok(です)?|了解(です)?|確認しました|ありがとうございます?|修正しました|対応しました|なるほど|承知(しました)?|わかりました|👍|:\+1:)[!！。.\s]*$/i;

const isFiller = (body: string): boolean => body.length === 0 || FILLER.test(body);

/** コメントは parentId でスレッドに束ねる。往復で意味が立つので 1 つずつ切らない。 */
export function threads(issue: Issue): { key: string; turns: Comment[] }[] {
  const byRoot = new Map<string, Comment[]>();
  for (const c of issue.comments) {
    if (isFiller(c.body) || isNoise(c.author)) continue;
    const root = c.parentId ?? c.id;
    byRoot.set(root, [...(byRoot.get(root) ?? []), c]);
  }
  return [...byRoot.entries()]
    .map(([root, turns]) => ({ key: `c:${root}`, turns: turns.sort((a, b) => a.at.localeCompare(b.at)) }))
    .sort((a, b) => (a.turns[0]?.at ?? "").localeCompare(b.turns[0]?.at ?? ""));
}

/** 埋め込みへ渡す文。**構造から文脈を前置する**（github.ts と同じ発想）。 */
export function embedTextFor(issue: Issue, part: { key: string; turns: Comment[] } | null): string {
  const head = [
    issue.id,
    issue.title,
    issue.project ? `プロジェクト: ${issue.project}` : null,
    `状態: ${issue.status}`,
  ]
    .filter(Boolean)
    .join(" / ");
  if (!part) return `${head}\n起票 @${issue.createdBy}: ${issue.description}`;
  const body = part.turns
    .map((c, i) => `${i === 0 ? "コメント" : "返信"} @${c.author}: ${c.body}`)
    .join("\n");
  return `${head}\n${body}`;
}

const hash = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// Linear の状態を記録の状態へ。**片方にしか無い状態を勝手に作らない。**
const STATUS: Record<string, string> = {
  triage: "planning",
  backlog: "planning",
  unstarted: "planning",
  started: "in-progress",
  completed: "done",
  canceled: "abandoned",
  duplicate: "abandoned",
};

/**
 * issue を記録として入れる。**1 issue = 1 記録**、本文とコメントのスレッドがその下の node。
 * `content_hash` が変わったものだけ埋め込みを取り直す（日次で回すため）。
 */
export async function ingestIssue(
  client: pg.Client,
  env: Env,
  workspace: string,
  scopeId: number,
  issue: Issue,
): Promise<{ nodes: number; embedded: number }> {
  const recordId = `linear:${issue.id}`;
  const parts: { key: string; turns: Comment[] | null }[] = [
    { key: "body", turns: null },
    ...threads(issue).map((t) => ({ key: t.key, turns: t.turns })),
  ];

  await client.query("begin");
  try {
    const recText = `${issue.id} ${issue.title}\n${issue.description}`;
    const existingRec = await client.query<{ raw_hash: string; has_emb: boolean }>(
      "select raw_hash, embedding is not null as has_emb from record where id = $1",
      [recordId],
    );
    const recNeeds = existingRec.rows[0]?.raw_hash !== hash(recText) || !existingRec.rows[0]?.has_emb;
    const recVec = recNeeds ? (await embed(env, [recText], "document"))[0] : undefined;

    await client.query(
      `insert into record (id, scope_id, schema_ver, title, status, problem, goal,
                           created_at, updated_at, raw, raw_hash, embedding)
       values ($1,$2,'linear/1',$3,$4,$5,'',$6,$7,$8,$9,$10)
       on conflict (id) do update set
         title=excluded.title, status=excluded.status, problem=excluded.problem,
         updated_at=excluded.updated_at, raw=excluded.raw, raw_hash=excluded.raw_hash,
         ingested_at=now(), embedding=coalesce(excluded.embedding, record.embedding)`,
      [
        recordId,
        scopeId,
        issue.title,
        STATUS[issue.statusType] ?? "in-progress",
        issue.description,
        issue.createdAt || new Date().toISOString(),
        issue.updatedAt || new Date().toISOString(),
        JSON.stringify(issue),
        hash(recText),
        vec(recVec),
      ],
    );

    const existing = new Map(
      (
        await client.query<{ key: string; content_hash: string; has_emb: boolean }>(
          "select key, content_hash, embedding is not null as has_emb from node where record_id=$1",
          [recordId],
        )
      ).rows.map((r) => [r.key, r]),
    );

    const texts = new Map(
      parts.map((p) => [p.key, embedTextFor(issue, p.turns ? { key: p.key, turns: p.turns } : null)]),
    );
    const need = parts.filter((p) => {
      const e = existing.get(p.key);
      return !e || e.content_hash !== hash(texts.get(p.key) ?? "") || !e.has_emb;
    });
    const vectors = need.length
      ? await embed(
          env,
          need.map((p) => texts.get(p.key) ?? ""),
          "document",
        )
      : [];
    const byKey = new Map(need.map((p, i) => [p.key, vectors[i]]));

    for (const [ordinal, p] of parts.entries()) {
      const v = byKey.get(p.key);
      const et = texts.get(p.key) ?? "";
      const text = p.turns
        ? p.turns.map((c) => `@${c.author}: ${c.body}`).join("\n")
        : `@${issue.createdBy}: ${issue.description}`;
      const at = p.turns ? (p.turns[0]?.at ?? issue.createdAt) : issue.createdAt;
      const actor = p.turns ? (p.turns[0]?.author ?? "unknown") : issue.createdBy;
      const nodeRow = await client.query<{ id: number }>(
        `insert into node (record_id, scope_id, kind, subkind, key, ordinal, at, text, polarity, attrs,
                           actor_kind, actor_name, content_hash, embed_text, embed_model, embedded_at, embedding)
         values ($1,$2,'utterance','issue',$3,$4,$5,$6,'na',$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (record_id, kind, key) do update set
           ordinal=excluded.ordinal, at=excluded.at, text=excluded.text, attrs=excluded.attrs,
           actor_kind=excluded.actor_kind, actor_name=excluded.actor_name,
           content_hash=excluded.content_hash, deleted_at=null,
           embed_text=coalesce(excluded.embed_text, node.embed_text),
           embed_model=coalesce(excluded.embed_model, node.embed_model),
           embedded_at=coalesce(excluded.embedded_at, node.embedded_at),
           embedding=coalesce(excluded.embedding, node.embedding)
         returning id`,
        [
          recordId,
          scopeId,
          p.key,
          ordinal,
          at || null,
          text,
          JSON.stringify({
            issue: issue.id,
            issueTitle: issue.title,
            project: issue.project,
            status: issue.status,
            labels: issue.labels,
            url: issue.url,
            authors: p.turns ? [...new Set(p.turns.map((c) => c.author))] : [issue.createdBy],
          }),
          actorKind(actor),
          actor,
          hash(et),
          v ? et : null,
          v ? EMBED_MODEL : null,
          v ? new Date().toISOString() : null,
          vec(v),
        ],
      );
      const nodeId = nodeRow.rows[0]?.id;
      if (nodeId === undefined) continue;

      const ref = await client.query<{ id: number }>(
        `insert into ref (kind, repo, key, url) values ('issue',$1,$2,$3)
         on conflict (kind, coalesce(repo,''), key) do update set url=coalesce(excluded.url, ref.url)
         returning id`,
        [workspace, issue.id, issue.url],
      );
      const refId = ref.rows[0]?.id;
      if (refId !== undefined) {
        await client.query(
          `insert into ref_link (ref_id, record_id, node_id, role) values ($1,$2,$3,'evidence')
           on conflict (ref_id, record_id, role, coalesce(node_id, 0)) do nothing`,
          [refId, recordId, nodeId],
        );
      }
    }

    // 消えたコメントは墓標にする。**全消しはしない** — 取得が空で返ったときに記録が消える。
    if (parts.length > 0) {
      await client.query(
        `update node set deleted_at = now()
         where record_id = $1 and deleted_at is null and key <> all($2::text[])`,
        [recordId, parts.map((p) => p.key)],
      );
    }

    await client.query("commit");
    return { nodes: parts.length, embedded: need.length };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
