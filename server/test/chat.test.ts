import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type OpenAI from "openai";
import { CODE_TOOLS, jstMonth, runTool, SYSTEM, TOOLS } from "../src/chat.ts";

// **UTC で切ると、月初 9 時間の利用が前月に落ちる。**
// 同じ取り違えを日付の集計で踏んでいる（chat.ts の JST_FROM の上に実測がある）。
test("月の境目は日本時間で切る", () => {
  assert.equal(jstMonth(Date.parse("2026-08-31T15:00:00Z")), "2026-09", "9/1 00:00 JST は 9 月");
  assert.equal(jstMonth(Date.parse("2026-08-31T14:59:59Z")), "2026-08", "8/31 23:59 JST は 8 月");
  assert.equal(jstMonth(Date.parse("2026-09-30T15:00:00Z")), "2026-10");
});

// **デプロイ先にはリポジトリが無い。**置き場所は scope_path がホストごとに持つので、
// リポジトリを持たないホストでは roots が空になり、コードへ到達できない。
// 読める前提の指示を渡したまま道具だけ外すと、読んでいないものを読んだように答える。
test("コードへ到達できないホストでは、読む指示を渡さない", () => {
  const off = SYSTEM([], [], false);
  assert.ok(off.includes("リポジトリのコードを読めない"), "到達できない事実を渡す");
  assert.ok(!off.includes("grep_code で探し"), "読めないのに読めと書かない");
  assert.ok(!off.includes("read_code で README.md を読む"), "読めないのに読めと書かない");

  const on = SYSTEM([], [], true);
  assert.ok(on.includes("grep_code で探し"), "読めるホストでは今までどおり");
  assert.ok(!on.includes("リポジトリのコードを読めない"), "読めるのに読めないと書かない");
});

// 指示と道具は同じ条件で切り替わる。**片方だけ外すと食い違う。**
test("コードの道具は本体の道具と分かれている", () => {
  // Tool は関数以外の型も含む合併なので、name を持つものだけ拾う。
  const names = (ts: OpenAI.Responses.Tool[]) =>
    ts.flatMap((t) => ("name" in t && typeof t.name === "string" ? [t.name] : [])).sort();
  assert.deepEqual(names(CODE_TOOLS), ["grep_code", "read_code"]);
  for (const n of ["grep_code", "read_code"]) {
    assert.ok(!names(TOOLS).includes(n), `${n} は本体側に残っていない`);
  }
});

// **AI 向けの出口を叩く。**`grepCode` が正しくても、ここで組み立てる JSON が違えば
// モデルには届かない（AGENTS.md「変更時の不変条件」）。
const codeCall = (args: Record<string, unknown>): OpenAI.Responses.ResponseFunctionToolCall => ({
  type: "function_call",
  call_id: "c1",
  name: "grep_code",
  arguments: JSON.stringify(args),
});

const utteranceCall = (args: Record<string, unknown>): OpenAI.Responses.ResponseFunctionToolCall => ({
  type: "function_call",
  call_id: "u1",
  name: "find_utterances",
  arguments: JSON.stringify(args),
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-chat-"));
fs.writeFileSync(path.join(fixture, "billing.ts"), "// 呼称は Cube 側で解決する\n");
const here = [{ label: "test/repo", dir: fixture }];

test("探せていない場所があるとき、モデルへ「無いと答えるな」を渡す", async () => {
  const out = await runTool(
    null as never,
    [],
    here,
    ["iroha924/mitos"],
    codeCall({ query: "どこにも書かれていない語句xyzzy" }),
    [],
    undefined,
  );
  const r = JSON.parse(out) as { found: number; unsearched?: string[]; note?: string };
  assert.equal(r.found, 0);
  assert.deepEqual(r.unsearched, ["iroha924/mitos: このホストに置かれていない"]);
  assert.match(r.note ?? "", /「無い」と答えない/);
});

test("探せていて 0 件のときだけ、コードに無いと言う", async () => {
  const out = await runTool(
    null as never,
    [],
    here,
    [],
    codeCall({ query: "どこにも書かれていない語句xyzzy" }),
    [],
    undefined,
  );
  const r = JSON.parse(out) as { found: number; unsearched?: string[]; note?: string };
  assert.equal(r.found, 0);
  assert.equal(r.unsearched, undefined);
  assert.match(r.note ?? "", /その語はコードに無い/);
});

test("発言を明示して探すときは横断検索へ昇格していないセッション発話も読む", async () => {
  const sql: string[] = [];
  const client = {
    query: async (statement: string) => {
      sql.push(statement);
      return { rows: [{ n: 0 }] };
    },
  };

  await runTool(client as never, [1], [], [], utteranceCall({ person: "iroha924" }), [], undefined);

  assert.equal(sql.length, 2);
  for (const statement of sql) {
    assert.match(statement, /n\.kind = 'utterance'/);
    assert.doesNotMatch(statement, /n\.searchable/);
  }
});
