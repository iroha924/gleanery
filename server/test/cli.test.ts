import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** DB も資格情報も無い環境で走らせる。ここで見たいのは引数の解釈と、DB へ繋ぐ前の検査だけ。 */
function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
      // 終わらない退行で試験ごと止まらないようにする（同期の呼び出しには --test-timeout が効かない）。
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; code?: string };
    // 時間切れは、期待どおりの出力を出した後でも失敗にする（終わらない退行を、終了コードの比べ方で通さない）。
    if (err.code === "ETIMEDOUT") throw new Error(`gleanery ${args.join(" ")} が 30 秒で終わらなかった`);
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// 引数を読み飛ばす解釈は、--avod と書いても絞り込みが掛からないまま成功し、
// 「過去に棄却されていないか」への答えが逆になる。
test("知らないフラグと知らないコマンドは DB へ繋ぐ前に落ちる", () => {
  for (const bad of ["--avod", "--limitt", "--all-scopes"]) {
    const r = run("search", "認証", bad);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`知らないフラグ: ${bad}`), `${bad}: ${r.out}`);
    assert.doesNotMatch(r.out, /DB が無い/, "DB へ繋ぎにいっている");
  }
  const r = run("frobnicate");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /知らないコマンド: frobnicate/);
  assert.doesNotMatch(r.out, /DB が無い/, "DB へ繋ぎにいっている");
});

// 全コマンド共通のフラグ表を持つと、そのコマンドが見もしないフラグが黙って通る。
// 通ってしまうと「指定したつもりの絞り込み」が効かないまま結果が返り、打った人は気付けない。
test("そのコマンドが取らないフラグと、余分な位置引数は名指しして落ちる", () => {
  for (const [args, want] of [
    [["doctor", "--yes"], /知らないフラグ: --yes/],
    [["project", "list", "--reset-docs"], /知らないフラグ: --reset-docs/],
    [["harvest", "--avoid"], /知らないフラグ: --avoid/],
    [["project", "list", "garbage"], /余分な引数: garbage/],
  ] as const) {
    const r = run(...args);
    assert.notEqual(r.code, 0, `gleanery ${args.join(" ")}: ${r.out}`);
    assert.match(r.out, want, r.out);
    assert.doesNotMatch(r.out, /DB が無い/, `gleanery ${args.join(" ")} が DB へ繋ぎにいった`);
  }
});

// エラーの見出しに打った引数が入ると、引数に仕込んだ改行で印の付いた偽の行を作れる。
test("エラーの見出しは、振り分けが決めた道の名前だけで作る", () => {
  assert.match(run("trace", "check").out, /^✦ gleanery trace check$/m);
  assert.match(
    run("trace", "check", "--limit", "0", "f").out,
    /^✦ gleanery trace check$/m,
    "引数の解釈で止まってもサブコマンドまで出す",
  );
  assert.match(run("search", "--lmit", "3", "認証").out, /^✦ gleanery search$/m);
  const flagValue = run("trace", "--cwd", "/nonexistent", "check");
  assert.match(flagValue.out, /^✦ gleanery$/m, flagValue.out);
  assert.doesNotMatch(flagValue.out, /^✦.*nonexistent/m, "フラグの値を見出しにしない");
  // 締めの行と状態の行は行頭に置く。中身は字下げするので、仕込んだ改行から行頭の偽の行を作れない
  for (const forged of [run("x\n✓ 直すものは無い"), run("x\n╰─ ✓ 直すものは無い")]) {
    assert.doesNotMatch(forged.out, /^(?:╰─ )?✓ 直すものは無い$/m, forged.out);
    assert.match(forged.out, /^✗ 止まった$/m, forged.out);
  }
});

test("--limit は 1 から 20 の整数だけ", () => {
  for (const v of ["abc", "0", "21", "1.5", "-1"]) {
    const r = run("search", "認証", `--limit=${v}`);
    assert.match(r.out, /--limit は 1 から 20 の整数にする/, `${v}: ${r.out}`);
  }
  assert.match(run("search", "認証", "--limit", "abc").out, /--limit は/, "--name 値 の形も解釈する");
});

test("引数なしと --help は、そこから下の使い方を出して成功する", () => {
  for (const args of [[], ["--help"], ["project", "--help"], ["db", "--help"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /使い方:/, `${args.join(" ")}: ${r.out}`);
  }
  // 使い方は宣言から組み立てる。書き写した文と食い違わせないため、コマンドの名前がそこに出ることを見る。
  assert.match(run("--help").out, /^ {2}db {2}/m);
  assert.match(run("db", "--help").out, /^ {2}migrate {2}/m);
  assert.match(run("project", "--help").out, /^ {2}forget {2}/m);
});

test("trace check は DB に触らずに記録の形を確かめる", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-cli-trace-"));
  try {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({
        schema: "trace/1",
        session: { host: "claude-code", id: "s" },
        items: [{ key: "x", kind: "finding", at: "2026-09-13", text: "t" }],
      }),
    );
    const r = run("trace", "check", bad);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ISO 8601/);
    const ok = path.join(dir, "ok.json");
    fs.writeFileSync(
      ok,
      JSON.stringify({ schema: "trace/1", session: { host: "claude-code", id: "s" }, items: [] }),
    );
    assert.equal(run("trace", "check", ok).code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init と check は資格情報の無い環境で動き、--cwd 以外の引数を拒否する", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-cli-init-")));
  try {
    const first = run("init", "--cwd", dir);
    assert.equal(first.code, 0, first.out);
    assert.equal(first.out, `✦ gleanery init\n.gleanery を作った: ${dir}\n`);
    assert.match(run("init", "--cwd", dir).out, /既に初期化済み/);
    assert.equal(run("check", "--cwd", dir).code, 0);
    for (const [bad, want] of [
      [["init", "other", "--cwd", dir], /余分な引数: other/],
      [["check", "--yes", "--cwd", dir], /知らないフラグ: --yes/],
    ] as const) {
      const r = run(...bad);
      assert.notEqual(r.code, 0);
      assert.match(r.out, want, r.out);
    }
    fs.mkdirSync(path.join(dir, ".gleanery/changes/a"));
    fs.writeFileSync(path.join(dir, ".gleanery/changes/a/change.json"), "{");
    const broken = run("check", "--cwd", dir);
    assert.equal(broken.code, 1, broken.out);
    assert.match(broken.out, /^ {2}✗ .*change\.json: JSON として読めない$/m);
    // 端末でない出力先（launchd のログ、Skill が読む出力）には色の制御文字を混ぜない。
    assert.equal(broken.out.includes(String.fromCodePoint(0x1b)), false, broken.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
