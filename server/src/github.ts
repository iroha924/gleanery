// GitHub の PR から発言をナレッジにする。
//
// **1 件 = 1 スレッド**（最初の指摘とその返信）。会話は往復で意味が立つので、
// 発言を 1 つずつ切ると「なぜそう言ったか」と「どう決着したか」が別々の断片になる。
// 1 スレッドは実測で平均 200〜600 字なので、これ以上の分割は要らない。
//
// **埋め込む文には文脈を前置する**（Anthropic の Contextual Retrieval と同じ発想）。
// ここでは PR の題・ファイル・発言者を構造から付けるので、LLM の推論は要らない。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

export type Thread = {
  key: string;
  pr: number;
  prTitle: string;
  path: string | null;
  line: number | null;
  at: string;
  /** 口を開いた順。最初が指摘、以降が返信 */
  turns: { author: string; body: string; at: string }[];
  url: string;
};

const gh = (repo: string, endpoint: string): unknown[] => {
  const out = execFileSync("gh", ["api", `repos/${repo}/${endpoint}`, "--paginate", "--slurp"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (JSON.parse(out) as unknown[][]).flat();
};

// 相槌はナレッジではない。**短さだけで落とさない** — 「これは DBT 側で」は 10 字でも中身がある。
const FILLER =
  /^(lgtm|ok(です)?|了解(です)?|確認しました|ありがとうございます?|修正しました|対応しました|なるほど|承知(しました)?|わかりました|👍|:\+1:|:eyes:|:pray:)[!！。.\s]*$/i;

const isFiller = (body: string): boolean => {
  const t = body.trim();
  return t.length === 0 || FILLER.test(t) || /^!?\[[^\]]*\]\([^)]*\)$/.test(t);
};

type ReviewComment = {
  id: number;
  in_reply_to_id?: number;
  user: { login: string } | null;
  body: string;
  path: string;
  line: number | null;
  created_at: string;
  html_url: string;
  pull_request_url: string;
};

type IssueComment = {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
  html_url: string;
  issue_url: string;
};

type Pull = { number: number; title: string };

/** repo は "owner/name"。PR のレビューと issue のコメントをスレッドへ束ねて返す。 */
export function collectThreads(repo: string): Thread[] {
  const titles = new Map<number, string>();
  for (const p of gh(repo, "pulls?state=all&per_page=100") as Pull[]) titles.set(p.number, p.title);

  const threads = new Map<string, Thread>();

  // レビューコメント。in_reply_to_id で親子が取れるので、スレッドに束ねられる。
  const reviews = gh(repo, "pulls/comments?per_page=100") as ReviewComment[];
  const byId = new Map(reviews.map((r) => [r.id, r]));
  for (const r of reviews) {
    if (isFiller(r.body)) continue;
    const root = r.in_reply_to_id ? (byId.get(r.in_reply_to_id) ?? r) : r;
    const pr = Number(root.pull_request_url.split("/").pop());
    const key = `pr-review:${repo}#${pr}:${root.id}`;
    const t = threads.get(key) ?? {
      key,
      pr,
      prTitle: titles.get(pr) ?? "",
      path: root.path ?? null,
      line: root.line ?? null,
      at: root.created_at,
      turns: [],
      url: root.html_url,
    };
    t.turns.push({ author: r.user?.login ?? "unknown", body: r.body.trim(), at: r.created_at });
    threads.set(key, t);
  }

  // issue / PR 本体のコメント。親子が無いので 1 件 = 1 スレッド。
  for (const c of gh(repo, "issues/comments?per_page=100") as IssueComment[]) {
    if (isFiller(c.body)) continue;
    const num = Number(c.issue_url.split("/").pop());
    const key = `issue:${repo}#${num}:${c.id}`;
    threads.set(key, {
      key,
      pr: num,
      prTitle: titles.get(num) ?? "",
      path: null,
      line: null,
      at: c.created_at,
      turns: [{ author: c.user?.login ?? "unknown", body: c.body.trim(), at: c.created_at }],
      url: c.html_url,
    });
  }

  for (const t of threads.values()) t.turns.sort((a, b) => a.at.localeCompare(b.at));
  return [...threads.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** 埋め込みへ渡す文。**構造から文脈を付ける。** */
export function threadText(t: Thread): string {
  const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "";
  const head = [`PR #${t.pr}`, t.prTitle, where].filter(Boolean).join(" / ");
  const body = t.turns.map((x, i) => `${i === 0 ? "指摘" : "返信"} @${x.author}: ${x.body}`).join("\n");
  return `${head}\n${body}`;
}

export const threadHash = (t: Thread): string =>
  crypto.createHash("sha256").update(threadText(t)).digest("hex");

// --- DB へ入れる ---

import type pg from "pg";
import { EMBED_MODEL, type Env, embed, vec } from "./db.ts";

/**
 * スレッドを node へ入れる。
 * **`content_hash` が変わったものだけ埋め込みを取り直す。**日次で回すので、
 * 毎回全件を埋め込むと費用と時間が線形に増える。
 */
export async function ingestThreads(
  client: pg.Client,
  env: Env,
  repo: string,
  scopeId: number,
  threads: Thread[],
  onProgress?: (m: string) => void,
): Promise<{ total: number; embedded: number }> {
  const recordId = `github:${repo}`;
  await client.query("begin");
  try {
    // リポジトリ 1 つ = 記録 1 つ。個々のスレッドはその下の node。
    await client.query(
      `insert into record (id, scope_id, schema_ver, title, status, problem, goal, created_at, updated_at, raw, raw_hash)
       values ($1,$2,'github/1',$3,'in-progress','','',now(),now(),'{}'::jsonb,'')
       on conflict (id) do update set updated_at = now(), ingested_at = now()`,
      [recordId, scopeId, `${repo} のレビューと議論`],
    );

    const existing = new Map(
      (
        await client.query<{ key: string; content_hash: string; has_emb: boolean }>(
          "select key, content_hash, embedding is not null as has_emb from node where record_id=$1",
          [recordId],
        )
      ).rows.map((r) => [r.key, r]),
    );

    const need = threads.filter((t) => {
      const e = existing.get(t.key);
      return !e || e.content_hash !== threadHash(t) || !e.has_emb;
    });
    onProgress?.(`スレッド ${threads.length} 件 / 埋め込みを取り直す ${need.length} 件`);

    const vectors = need.length ? await embed(env, need.map(threadText), "document") : [];
    const byKey = new Map(need.map((t, i) => [t.key, vectors[i]]));

    for (const t of threads) {
      const v = byKey.get(t.key);
      const text = t.turns.map((x) => `@${x.author}: ${x.body}`).join("\n");
      const r = await client.query<{ id: number }>(
        `insert into node (record_id, scope_id, kind, subkind, key, at, text, polarity, attrs,
                           actor_kind, actor_name, content_hash, embed_text, embed_model, embedded_at, embedding)
         values ($1,$2,'utterance',$3,$4,$5,$6,'na',$7,'human',$8,$9,$10,$11,$12,$13)
         on conflict (record_id, kind, key) do update set
           at=excluded.at, text=excluded.text, subkind=excluded.subkind, attrs=excluded.attrs,
           actor_name=excluded.actor_name, content_hash=excluded.content_hash, deleted_at=null,
           embed_text=coalesce(excluded.embed_text, node.embed_text),
           embed_model=coalesce(excluded.embed_model, node.embed_model),
           embedded_at=coalesce(excluded.embedded_at, node.embedded_at),
           embedding=coalesce(excluded.embedding, node.embedding)
         returning id`,
        [
          recordId,
          scopeId,
          t.key.startsWith("pr-review:") ? "review" : "issue",
          t.key,
          t.at,
          text,
          JSON.stringify({
            pr: t.pr,
            prTitle: t.prTitle,
            path: t.path,
            line: t.line,
            url: t.url,
            authors: [...new Set(t.turns.map((x) => x.author))],
          }),
          // 最初に口を開いた人。返信者は attrs.authors に残す。
          t.turns[0]?.author ?? "unknown",
          threadHash(t),
          v ? threadText(t) : null,
          v ? EMBED_MODEL : null,
          v ? new Date().toISOString() : null,
          vec(v),
        ],
      );
      const nodeId = r.rows[0]?.id;
      if (nodeId === undefined) continue;

      // **どのファイルの話かを辺にする。**これが無いと check_path から引けない。
      for (const [kind, key, url] of [
        ["pr", `${repo}#${t.pr}`, t.url],
        ...(t.path ? [["file", t.path, null] as const] : []),
      ] as [string, string, string | null][]) {
        const ref = await client.query<{ id: number }>(
          `insert into ref (kind, repo, key, url) values ($1,$2,$3,$4)
           on conflict (kind, coalesce(repo,''), key) do update set url=coalesce(excluded.url, ref.url)
           returning id`,
          [kind, repo, key, url],
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
    }
    await client.query("commit");
    return { total: threads.length, embedded: need.length };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
