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
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", KNOWLEDGE_ENV_DIR: "/nonexistent" },
      // 終わらない退行で試験ごと止まらないようにする（同期の呼び出しには --test-timeout が効かない）。
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; code?: string };
    // 時間切れは、期待どおりの出力を出した後でも失敗にする（終わらない退行を、終了コードの比べ方で通さない）。
    if (err.code === "ETIMEDOUT") throw new Error(`mitos ${args.join(" ")} が 30 秒で終わらなかった`);
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// 手書きのループは未知のフラグを読み飛ばす。--avod と書くと絞り込みが掛からないまま成功し、
// 「過去に棄却されていないか」への答えが逆になる。
test("知らないフラグと知らないコマンドは DB へ繋ぐ前に落ちる", () => {
  for (const bad of ["--avod", "--limitt", "--all-scopes"]) {
    const r = run("search", "認証", bad);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /Unknown option/, `${bad}: ${r.out}`);
  }
  const r = run("frobnicate");
  assert.match(r.out, /知らないコマンド: frobnicate/);
  // エラーの見出しはサブコマンドまで出し、引数に仕込んだ改行で印の無い偽の締めの行を作らせない。
  assert.match(run("trace", "check").out, /^✦ mitos trace check$/m);
  assert.match(
    run("trace", "--cwd", "/nonexistent", "check").out,
    /^✦ mitos trace check$/m,
    "フラグの値を見出しにしない",
  );
  assert.match(
    run("search", "--lmit", "3", "認証").out,
    /^✦ mitos search$/m,
    "知らないフラグの値も見出しにしない",
  );
  const forged = run("x\n╰─ ✓ 直すものは無い");
  assert.doesNotMatch(forged.out, /^╰─ ✓ 直すものは無い$/m, forged.out);
  assert.doesNotMatch(r.out, /KNOWLEDGE_DB_URL_\w* が無い/, "DB へ繋ぎにいっている");
});

test("--limit は 1 から 20 の整数だけ", () => {
  for (const v of ["abc", "0", "21", "1.5", "-1"]) {
    const r = run("search", "認証", `--limit=${v}`);
    assert.match(r.out, /--limit は 1 から 20 の整数にする/, `${v}: ${r.out}`);
  }
  assert.match(run("search", "認証", "--limit", "abc").out, /--limit は/, "--name 値 の形も解釈する");
});

test("引数なしと --help は使い方を出して成功する", () => {
  for (const args of [[], ["--help"], ["help"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /使い方:/);
  }
});

test("trace check は DB に触らずに記録の形を確かめる", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-cli-trace-"));
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mitos-cli-init-")));
  try {
    const first = run("init", "--cwd", dir);
    assert.equal(first.code, 0, first.out);
    assert.equal(first.out, `✦ mitos init\n╰─ .mitos を作った: ${dir}\n`);
    assert.match(run("init", "--cwd", dir).out, /既に初期化済み/);
    assert.equal(run("check", "--cwd", dir).code, 0);
    for (const [bad, want] of [
      [["init", "other", "--cwd", dir], /Unexpected argument 'other'/],
      [["check", "--yes", "--cwd", dir], /Unknown option '--yes'/],
    ] as const) {
      const r = run(...bad);
      assert.notEqual(r.code, 0);
      assert.match(r.out, want, r.out);
    }
    fs.mkdirSync(path.join(dir, ".mitos/changes/a"));
    fs.writeFileSync(path.join(dir, ".mitos/changes/a/change.json"), "{");
    const broken = run("check", "--cwd", dir);
    assert.equal(broken.code, 1, broken.out);
    assert.match(broken.out, /^│ ✗ .*change\.json: JSON として読めない$/m);
    // 端末でない出力先（launchd のログ、Skill が読む出力）には色の制御文字を混ぜない。
    assert.equal(broken.out.includes(String.fromCodePoint(0x1b)), false, broken.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
