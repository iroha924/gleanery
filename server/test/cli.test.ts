import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** DB も資格情報も無い環境で走らせる。ここで見たいのは引数の解釈だけ。 */
function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", KNOWLEDGE_ENV_DIR: "/nonexistent" },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("知らないフラグを黙って捨てない", () => {
  // 手書きのループは未知のフラグを読み飛ばしていた。--dnot と書くと dont 絞り込みが
  // 掛からないまま成功し、「過去に棄却されていないか」への答えが逆になる。
  for (const bad of ["--dnot", "--limitt", "--all-scopes"]) {
    const r = run("search", "認証", bad);
    assert.notEqual(r.code, 0, `${bad} が成功してしまう`);
    assert.match(r.out, /Unknown option/, `${bad}: ${r.out}`);
  }
});

test("--name=値 の形を受ける", () => {
  // 手書きのループは `--cwd=/other/repo` を位置引数として捨て、警告も出さずに
  // process.cwd() の作業場所へ書いていた。ここでは解釈されたことだけを確かめる
  // （解釈されなければ「知らないコマンド」ではなく別の失敗になる）。
  const r = run("search", "認証", "--limit=abc");
  assert.match(r.out, /--limit は 1 から 20 の整数にする: abc/, r.out);
});

test("--limit は 1 から 20 の整数だけ", () => {
  // MCP 側は zod で縛っている。CLI だけ穴が開くと -1 が Voyage の top_k へ流れ、
  // 失敗時の slice(0, -1) がプール 30 件のうち 29 件を吐く。
  for (const v of ["abc", "0", "21", "1.5", "-1"]) {
    const r = run("search", "認証", "--limit", v);
    assert.notEqual(r.code, 0, `--limit ${v} が通ってしまう`);
  }
  // 正しい値は引数の検証では落ちない（この先は DB が要るので、別の理由で失敗する）
  const ok = run("search", "認証", "--limit", "20");
  assert.doesNotMatch(ok.out, /--limit は/, ok.out);
});

test("知らないコマンドは DB へ繋ぐ前に落ちる", () => {
  const r = run("frobnicate");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /知らないコマンド: frobnicate/);
  // connect() が投げるのはこの文言。出ていれば接続を試みたということ。
  assert.doesNotMatch(r.out, /KNOWLEDGE_DB_URL が無い/, "DB へ繋ぎにいっている");
});

test("引数なしと --help は使い方を出して成功する", () => {
  for (const args of [[], ["--help"], ["help"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /使い方:/);
  }
});

test("init と check は資格情報の無い環境で動き、--cwd 以外の引数を拒否する", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mitos-cli-init-")));
  try {
    const first = run("init", "--cwd", dir);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /\.mitos を作った/);
    assert.match(run("init", "--cwd", dir).out, /既に初期化済み/);
    const ok = run("check", "--cwd", dir);
    assert.equal(ok.code, 0, ok.out);

    // 位置引数は黙って捨てると、別の場所を初期化したつもりで cwd を扱う
    for (const bad of [
      ["init", "other", "--cwd", dir],
      ["init", "--all", "--cwd", dir],
      ["check", "--yes", "--cwd", dir],
    ]) {
      const r = run(...bad);
      assert.notEqual(r.code, 0, `${bad.join(" ")} が通ってしまう`);
      assert.match(r.out, /--cwd だけ/, r.out);
    }
    assert.match(run("init", "--foo", "--cwd", dir).out, /Unknown option/);

    fs.mkdirSync(path.join(dir, ".mitos/changes/a"));
    fs.writeFileSync(path.join(dir, ".mitos/changes/a/change.json"), "{");
    const broken = run("check", "--cwd", dir);
    assert.equal(broken.code, 1, broken.out);
    assert.match(broken.out, /change\.json: JSON として読めない/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
