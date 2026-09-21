// SQL を組み立てさせるためだけのテスト。返り値の正しさは各機能のテストが見る。
//
// **ここが薄いと scripts/check-sql-parse.mjs が空振りする。**あの検査は組み立てられた SQL しか
// 実 PostgreSQL へ通せないので、到達しない経路は緑のまま壊れる（#85 の 2 つの欠陥は、どちらも
// どのテストからも SQL が出ない場所にあった）。
//
// 契約は「その経路が SQL を組み立てること」だけ。途中で投げてもよい（外部サービスへ出る手前で
// 止まる経路がある）。組み立てた数だけを見る。

import assert from "node:assert/strict";
import { test } from "node:test";
import { syncDocs } from "../src/docs.ts";
import { fillMessages } from "../src/embeddings.ts";
import { projectId } from "../src/project.ts";
import { directory, listItems, openWork, pathRules, read, workDetail } from "../src/search.ts";
import { fillTitles } from "../src/titles.ts";
import { checkTrace, saveTrace, type Trace } from "../src/trace.ts";
import { type Call, fakeDb } from "./fake-db.ts";
import { put, withRepo } from "./temp-repo.ts";

/** SQL を組み立てたことだけを見る。0 件なら、その経路は検査へ材料を渡していない。 */
async function builds(
  what: string,
  run: (db: Parameters<typeof pathRules>[0]) => Promise<unknown>,
  respond?: Parameters<typeof fakeDb>[0],
): Promise<Call[]> {
  const { db, calls } = fakeDb(respond);
  await run(db).catch(() => {});
  assert.ok(calls.length > 0, `${what} が SQL を 1 文も組み立てていない`);
  return calls;
}

const has = (sql: string, ...parts: string[]) => parts.every((p) => sql.includes(p));

// 参照ごとに 1 回ずつ呼ぶ。まとめて渡すと、1 件目が投げた時点で残りの参照の SQL が出ない
// （実測: k: の整形で投げて m: / s: / w: が 1 文も出ていなかった）。
test("参照の読み出しは、4 種類すべてで本体と続きの SQL を組み立てる", async () => {
  const respond: Parameters<typeof fakeDb>[0] = (sql) => {
    if (has(sql, `"gleanery"."knowledge" as "k"`)) {
      return [
        {
          id: "12",
          kind: "decision",
          status: "accepted",
          stance: null,
          heading: "見出し",
          body: "本文",
          reason: null,
          confirmation: null,
          downsides: null,
          occurred_at: new Date(),
          project: "p",
          source_kind: null,
          path: null,
          url: null,
          successor: null,
          decision_id: "12",
        },
      ];
    }
    if (has(sql, `"gleanery"."message" as "m"`, `"gleanery"."conversation" as "c"`)) {
      return [
        {
          conversation_id: "c1",
          sent_at: new Date(),
          id: "00000000-0000-8000-8000-000000000001",
          body: "発言",
          speaker_kind: "self",
          paths: [],
        },
      ];
    }
    if (has(sql, `"gleanery"."source_item" as "s"`)) {
      return [
        {
          kind: "pull_request",
          external_id: "1",
          title: "題",
          state: "open",
          url: "https://example.invalid/1",
          path: null,
          body: null,
          source_updated_at: new Date(),
          project: "p",
          metadata: {},
          conversation: "c1",
        },
      ];
    }
    if (has(sql, `"gleanery"."work_item" as "w"`)) {
      return [
        {
          id: "4",
          title: "作業",
          status: "open",
          project: "p",
          updated_at: new Date(),
          conversation_id: "c1",
          body: null,
        },
      ];
    }
    return [];
  };
  for (const ref of ["k:12", "m:00000000-0000-8000-8000-000000000001", "s:3", "w:4"]) {
    await builds(`read ${ref}`, (db) => read(db, [ref], 4096), respond);
  }
});

test("作業と取り込み元の一覧は、絞り込みの有無で SQL を組み立てる", async () => {
  await builds("openWork", (db) => openWork(db, [1]));
  await builds(
    "workDetail",
    (db) => workDetail(db, "4", [1]),
    () => [
      {
        id: "4",
        title: "作業",
        status: "open",
        project: "p",
        updated_at: new Date(),
        conversation_id: "c1",
        body: null,
      },
    ],
  );
  await builds("pathRules", (db) => pathRules(db, 1));
  await builds("directory", (db) => directory(db));
  await builds("projectId", (db) => projectId(db, "git:github.com/iroha924/gleanery"));
  await builds("listItems（絞り込みあり）", (db) =>
    listItems(db, { projects: [1], kind: "pull_request", state: "merged", since: "2026-09-01", limit: 5 }),
  );
  // 作業場所を絞らない形も通す。inScope の分岐で別の SQL が出る。
  await builds("listItems（作業場所なし）", (db) => listItems(db, { projects: null, limit: 5 }));
});

// 鍵は「無ければ何もせず戻る」分岐を外すためだけに渡す。対象が 0 行なら外部サービスへは出ない。
test("埋め込みと題の補充は、対象が無くても問い合わせを組み立てる", async () => {
  await builds("fillMessages", (db) => fillMessages(db, { VOYAGE_API_KEY: "使わない" }));
  await builds("fillTitles", (db) => fillTitles(db, { OPENAI_API_KEY: "使わない" }));
});

// 検証器を通して作る。手で組むと zod の既定値（files / refs / downsides の空配列）が入らず、
// 本物と違う形を検査してしまう（実測: files が undefined で、書き込みの手前で投げていた）。
function trace(items: unknown[], work?: unknown): Trace {
  const r = checkTrace({
    schema: "trace/1",
    session: { host: "claude-code", id: "sql-corpus" },
    items,
    ...(work ? { work } : {}),
  });
  assert.deepEqual(r.problems, [], "記録の見本が trace/1 として通らない");
  return r.trace as Trace;
}

const decision = {
  key: "d-1",
  kind: "decision",
  status: "accepted",
  at: "2026-09-13T10:00:00+09:00",
  text: "決めたこと",
  context: "背景",
  options: [
    { text: "採った案", chosen: true },
    { text: "棄却した案", chosen: false, why: "理由" },
  ],
  confirmation: "確かめ方",
  // 触ったファイルがあると knowledge_file の書き込みが出る。空のままだとその枝が出ない。
  files: [{ path: "server/src/db.ts", role: "evidence" }],
};

// 別の session の決定を覆す形。この枝だけが、外の決定を引く問い合わせと輪の検査を組み立てる。
const supersede = { ...decision, key: "d-2", supersedes: "other:sess#d-0" };

// 入力の key をそのまま書けたことにして返す。ここを返さないと「知識を書けなかった」で止まり、
// 案の入れ替え・ファイル・埋め込みの SQL が出ない。
let ids = 0;
const wrote: Parameters<typeof fakeDb>[0] = (sql, params) => {
  if (sql.includes("with incoming")) {
    return (JSON.parse(String(params[0])) as { source_key: string }[]).map((r) => ({
      id: String(++ids),
      source_key: r.source_key,
      written: true,
    }));
  }
  if (has(sql, `"gleanery"."work_item"`)) return [{ id: "9" }];
  // 外の session の決定は「在る」ことにする。引けないと、覆す枝が書き込みの手前で止まる。
  if (has(sql, `from "gleanery"."knowledge"`, `"kind" = $2`)) {
    return [{ id: "99", source_key: "other:sess#d-0" }];
  }
  if (sql.includes("with recursive chain")) return [];
  // 覆した件数が 0 だと、採った案を was_chosen へ移す更新が出ない。
  if (has(sql, `update "gleanery"."knowledge" set`, "superseded_by_id")) return [{ id: "99" }];
  return [];
};

test("記録の保存は、要素のある形と空の形の両方で SQL を組み立てる", async () => {
  const work = { key: "w-1", title: "作業", goal: "測れる結果", current: "調べている", status: "active" };
  await builds("saveTrace", (db) => saveTrace(db, {}, 1, trace([decision], work)), wrote);
  // 空の items が別の SQL を出す。集合を受ける枝は、空と非空で組み立てが変わる
  // （空配列を in / not in へ渡して `in ()` になった #85 の欠陥がこれだった）。
  await builds("saveTrace（items が空）", (db) => saveTrace(db, {}, 1, trace([])), wrote);
  await builds(
    "saveTrace（別の session の決定を覆す）",
    (db) => saveTrace(db, {}, 1, trace([supersede])),
    wrote,
  );
});

// 取り込み元の行が引けないと、同期は最初の問い合わせで戻る。
const connector: Parameters<typeof fakeDb>[0] = (sql) =>
  has(sql, `"gleanery"."connector"`, "select") ? [{ id: "1", head_oid: null, snapshot_at: null }] : [];

test("文書の同期は、文書がある形と 1 本も無い形の両方で SQL を組み立てる", async () => {
  await withRepo(async (repo, git) => {
    put(repo, "docs/a.md", "# 見出し\n\n本文です。\n");
    git("add", "-A");
    git("commit", "-qm", "docs");
    await builds("syncDocs", (db) => syncDocs(db, 1, repo, { remote: false }), connector);
  });
  // Markdown が 1 本も無いリポジトリ。空配列を in / not in へ渡して毎回落ちていたのがこの形である。
  await withRepo(async (repo, git) => {
    put(repo, "src/a.ts", "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "code");
    await builds("syncDocs（Markdown が無い）", (db) => syncDocs(db, 1, repo, { remote: false }), connector);
  });
});
