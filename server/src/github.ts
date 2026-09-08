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
import { actorKind, isNoise } from "./actor.ts";

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

type RawIssue = {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  state: string;
  created_at: string;
  html_url: string;
  /** この鍵があるものは PR。issues エンドポイントは PR も返す */
  pull_request?: unknown;
};

type Pull = {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  created_at: string;
  html_url: string;
  head?: { ref?: string };
};

/**
 * PR と issue そのもの。**コメントだけ入れても本体は入らない。**
 * PR では「私の最新のマージ済み PR」に答えられず（実測）、issue では
 * **本文がまるごと落ちる** — issues/comments は付いたコメントしか返さないので、
 * 実装より先に設計を issue へ書く進め方だと、決めたこと自体が 1 件も入らない
 * （実測: nomophyl の 108 件・213,863 字が全部欠けていた）。
 */
export type Pr = {
  number: number;
  kind: "pr" | "issue";
  title: string;
  body: string;
  author: string;
  /** open / merged / closed。closed は「マージせず閉じた」 */
  state: "open" | "merged" | "closed";
  /** 並べ替えに使う日付。マージ済みならマージ日、そうでなければ作成日 */
  at: string;
  /** 作った日。**at と別に持つ** — 「作成した最新」と「マージした最新」は別の問い */
  createdAt: string;
  url: string;
  branch: string;
};

const prOf = (p: Pull): Pr => ({
  number: p.number,
  kind: "pr",
  title: p.title,
  body: (p.body ?? "").trim(),
  author: p.user?.login ?? "unknown",
  state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
  // **マージ済みならマージ日。**「最新のマージ済み PR」は作成順ではなくマージ順で並ぶ。
  at: p.merged_at ?? p.created_at,
  createdAt: p.created_at,
  url: p.html_url,
  branch: p.head?.ref ?? "",
});

/**
 * 埋め込む文。題と本文だけ。差分は入れない（長すぎて意味が薄まる）。
 *
 * **本文は 12,000 字まで取る。**設計を issue へ書く進め方だと本文がそのまま設計文書になり、
 * 4,000 字では後半が消える（実測: nomophyl の最長 11,450 字、中央値 1,299 字）。
 */
export const prText = (p: Pr): string =>
  `${p.kind === "pr" ? "PR" : "issue"} #${p.number} ${p.title}${p.body ? `\n${p.body.slice(0, 12_000)}` : ""}`;

/** repo は "owner/name"。PR と issue の本体、レビュー / issue のコメントを返す。 */
export function collect(repo: string): { prs: Pr[]; threads: Thread[] } {
  const titles = new Map<number, string>();
  const prs: Pr[] = [];
  for (const p of gh(repo, "pulls?state=all&per_page=100") as Pull[]) {
    titles.set(p.number, p.title);
    // **PR は bot が作ったものも入れる。**isNoise はコメント用の判定で、
    // 「Terraform の plan 結果」のような推論を含まない通知を落とすためのもの。
    // リリース PR は release-bot[bot] が作るので、ここで落とすと
    // 「いつ何がリリースされたか」に答えられなくなる（実測: dbt #361 が丸ごと欠けていた）。
    prs.push(prOf(p));
  }

  // issue 本体。**issues エンドポイントは PR も返す**ので、pull_request を持つものは
  // 上の pulls で入っている。番号も本文も同じなので、ここで落とさないと二重になる。
  for (const i of gh(repo, "issues?state=all&per_page=100") as RawIssue[]) {
    if (i.pull_request) continue;
    titles.set(i.number, i.title);
    prs.push({
      number: i.number,
      kind: "issue",
      title: i.title,
      body: (i.body ?? "").trim(),
      author: i.user?.login ?? "unknown",
      // issue に merged は無い。closed は「解決した」と「やらないことにした」の両方を含む。
      state: i.state === "open" ? "open" : "closed",
      at: i.created_at,
      createdAt: i.created_at,
      url: i.html_url,
      branch: "",
    });
  }

  const threads = new Map<string, Thread>();

  // レビューコメント。in_reply_to_id で親子が取れるので、スレッドに束ねられる。
  const reviews = gh(repo, "pulls/comments?per_page=100") as ReviewComment[];
  const byId = new Map(reviews.map((r) => [r.id, r]));
  for (const r of reviews) {
    if (isFiller(r.body) || isNoise(r.user?.login ?? "")) continue;
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
    if (isFiller(c.body) || isNoise(c.user?.login ?? "")) continue;
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
  return {
    prs: prs.sort((a, b) => a.at.localeCompare(b.at)),
    threads: [...threads.values()].sort((a, b) => a.at.localeCompare(b.at)),
  };
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

// 1 トランザクションで扱う件数。
//
// **全件を 1 つのトランザクションに入れない。**begin してから埋め込みを取りに行くので、
// その間ずっと「開いたまま何もしていない」状態になる。実測: main-repo は
// スレッド 24,568 件で、埋め込みだけで 30 分を超えた。途中で切れると全部消えるうえ、
// 30 分ぶんの API 費用も無駄になる。分けて確定すれば、落ちても続きから再開できる
// （content_hash が一致するものは次回そのまま飛ばされる）。
const CHUNK = 500;

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
  prs: Pr[],
  threads: Thread[],
  onProgress?: (m: string) => void,
): Promise<{ total: number; prs: number; embedded: number }> {
  const recordId = `github:${repo}`;

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

  const stale = new Set(
    threads
      .filter((t) => {
        const e = existing.get(t.key);
        return !e || e.content_hash !== threadHash(t) || !e.has_emb;
      })
      .map((t) => t.key),
  );
  onProgress?.(`スレッド ${threads.length} 件 / 埋め込みを取り直す ${stale.size} 件`);

  // **PR そのものを先に入れる。**コメントだけだと「私の最新のマージ済み PR は」に
  // 答えられない（実測: 「マージします！」という発言が 8 件返っただけだった）。
  const prStale = prs.filter((p) => {
    const e = existing.get(`${p.kind}:${p.number}`);
    return !e || e.content_hash !== crypto.createHash("sha256").update(prText(p)).digest("hex") || !e.has_emb;
  });
  for (let from = 0; from < prStale.length; from += CHUNK) {
    const slice = prStale.slice(from, from + CHUNK);
    const vectors = await embed(env, slice.map(prText), "document");
    await client.query("begin");
    try {
      for (const [i, p] of slice.entries()) {
        await client.query(
          `insert into node (record_id, scope_id, kind, subkind, key, at, text, polarity, status, attrs,
                             actor_kind, actor_name, content_hash, embed_text, embed_model, embedded_at, embedding)
           values ($1,$2,'event',$3,$4,$5,$6,'na',$7,$8,$9,$10,$11,$12,$13,$14,$15)
           on conflict (record_id, kind, key) do update set
             at=excluded.at, text=excluded.text, status=excluded.status, attrs=excluded.attrs,
             subkind=excluded.subkind,
             actor_kind=excluded.actor_kind, actor_name=excluded.actor_name,
             content_hash=excluded.content_hash, deleted_at=null,
             embed_text=excluded.embed_text, embed_model=excluded.embed_model,
             embedded_at=excluded.embedded_at, embedding=excluded.embedding`,
          [
            recordId,
            scopeId,
            p.kind,
            `${p.kind}:${p.number}`,
            p.at,
            prText(p),
            p.state,
            // **PR の attrs の形は変えない。**チャットと check-path が attrs->>'pr' を読む。
            JSON.stringify(
              p.kind === "pr"
                ? {
                    pr: p.number,
                    prTitle: p.title,
                    state: p.state,
                    url: p.url,
                    branch: p.branch,
                    createdAt: p.createdAt,
                  }
                : { issue: p.number, title: p.title, state: p.state, url: p.url, createdAt: p.createdAt },
            ),
            actorKind(p.author),
            p.author,
            crypto.createHash("sha256").update(prText(p)).digest("hex"),
            prText(p),
            EMBED_MODEL,
            new Date().toISOString(),
            vec(vectors[i]),
          ],
        );
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    }
    onProgress?.(`  PR ${Math.min(from + CHUNK, prStale.length)} / ${prStale.length} 件を確定`);
  }

  // **変わっていないものは書き直さない。**content_hash が同じなら本文も出自も同じで、
  // 書いても結果は変わらない。日次で回すのに全件へ 1 件 4 クエリを投げると、
  // main-repo だけで 10 万回の往復になる（実測: 書き込みだけで 30 分）。
  const changed = threads.filter((t) => stale.has(t.key));
  let done = 0;
  for (let from = 0; from < changed.length; from += CHUNK) {
    const slice = changed.slice(from, from + CHUNK);
    const need = slice;
    // **埋め込みはトランザクションの外で取る。**中で待つと、その間ずっと開いたままになる。
    const vectors = need.length ? await embed(env, need.map(threadText), "document") : [];
    const byKey = new Map(need.map((t, i) => [t.key, vectors[i]]));

    await client.query("begin");
    try {
      await writeSlice(client, recordId, repo, scopeId, slice, byKey);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    }
    done += slice.length;
    onProgress?.(`  ${done} / ${changed.length} 件を確定`);
  }
  return { total: threads.length, prs: prStale.length, embedded: stale.size };
}

/** 1 チャンクぶんを書く。呼び出し側がトランザクションを持つ。 */
async function writeSlice(
  client: pg.Client,
  recordId: string,
  repo: string,
  scopeId: number,
  threads: Thread[],
  byKey: Map<string, number[] | undefined>,
): Promise<void> {
  for (const t of threads) {
    const v = byKey.get(t.key);
    const text = t.turns.map((x) => `@${x.author}: ${x.body}`).join("\n");
    const r = await client.query<{ id: number }>(
      `insert into node (record_id, scope_id, kind, subkind, key, at, text, polarity, attrs,
                           actor_kind, actor_name, content_hash, embed_text, embed_model, embedded_at, embedding)
         values ($1,$2,'utterance',$3,$4,$5,$6,'na',$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (record_id, kind, key) do update set
           at=excluded.at, text=excluded.text, subkind=excluded.subkind, attrs=excluded.attrs,
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
        actorKind(t.turns[0]?.author ?? "unknown"),
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
}
