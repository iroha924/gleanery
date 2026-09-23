// 実 DB に対して、配る entrypoint を子プロセスで走らせるための足回り。
//
// 親が期限と終了を持つ。`.claude/rules/verification.md` が禁じている「テストが DB へ繋ぐ」は、
// pool を掴んだまま返らない形が原因だった。子プロセスなら、その責務を親が外から果たせる。

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

export const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

/** 子プロセスの上限。超えたら殺して、その事実を検査の失敗として扱う。 */
const TIMEOUT_MS = 120_000;

/** 使い捨てのプロジェクト。git の remote を持たせて、プロジェクトの key を安定させる。 */
export function makeRepo(dir, remote = "https://github.com/example/live.git", name = "repo") {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", remote);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/design.md"), "# 設計\n\n判断の理由をここに書く。\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# live\n\n検査のためのプロジェクト。\n");
  git("add", "-A");
  git("commit", "-qm", "docs");
  return repo;
}

/**
 * `gh` の偽物を置く。`syncGithub` は内部で gh を起動するので、これが無いと 14 箇所へ届かない。
 * 外の GitHub へは出ない。返すのは検査のために作った固定の JSON である。
 */
export function fakeGh(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
// 検査のための偽物。外へは出ない。gh は --slurp を付けるのでページの配列で返す。
// comments を先に見る。\`pulls/comments\` は \`/pulls\` にも当たるので、順を逆にすると
// レビューのコメントの代わりに PR that が返り、pull_request_url が無くて落ちる。
const args = process.argv.slice(2).join(" ");
const out = (v) => process.stdout.write(JSON.stringify([v]));
const person = { id: 1, login: "someone" };
// 2 巡目は発言と issue を減らす。消えた発言・消えた issue を消す枝は、前より減ったときにしか通らない。
const round2 = process.env.GLEANERY_FAKE_GH_ROUND === "2";
if (args.includes("pulls/comments")) {
  if (round2) { out([]); process.exit(0); }
  out([{ id: 11, pull_request_url: "https://api.github.com/repos/example/live/pulls/1", user: person,
         body: "ここは実 DB で確かめたい", created_at: "2026-09-02T00:00:00Z",
         html_url: "https://example.invalid/1#r11", path: "docs/design.md", line: 3 }]);
} else if (args.includes("issues/comments")) {
  if (round2) { out([]); process.exit(0); }
  out([{ id: 12, issue_url: "https://api.github.com/repos/example/live/issues/2", user: person,
         body: "偽の db では権限が見えない", created_at: "2026-09-03T00:00:00Z",
         html_url: "https://example.invalid/2#c12" }]);
} else if (args.includes("pulls?")) {
  // 2 巡目は題だけを変える。題は発言の中身ではないので、発言を書き直さない。
  out([{ number: 1, title: round2 ? "題を変えた PR" : "はじめの PR", body: "本文", state: "open", user: person,
         created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
         html_url: "https://example.invalid/1", merged_at: null, closed_at: null }]);
} else if (args.includes("issues?")) {
  if (round2) { out([]); process.exit(0); }
  out([{ number: 2, title: "はじめの issue", body: "本文", state: "closed", user: person,
         created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
         html_url: "https://example.invalid/2", closed_at: "2026-09-03T00:00:00Z" }]);
} else {
  out([]);
}
`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * 子プロセスの環境。DB は一時 HOME の ~/.gleanery/gleanery.db（`gleanery init` で作る）。
 * GitHub のキーを渡さない（偽の gh だけを使う）。
 */
export function childEnv(dir, covDir, extra = {}) {
  const env = { ...process.env, ...extra };
  // **home を付け替える。**付け替えないと、子プロセスは持ち主の ~/.gleanery を使う。
  // `capture flush` は ~/.gleanery/spool の待ち行列を読んで、送り終えた分を消す（実測: 持ち主の
  // 未送信 4 件を使い捨ての DB へ送り、spool から消した）。DB の path を変えるだけでは塞がらない。
  env.HOME = dir;
  env.USERPROFILE = dir;
  // 親の GLEANERY_DB が残ると、子は一時 HOME ではなくそちらの DB を開く。
  for (const k of ["GLEANERY_DB", "GITHUB_TOKEN"]) delete env[k];
  // ホストの session は親から漏れ込む。両方あると CLI が「どちらのホストか決められない」で止まるので、
  // 検査が渡したものだけを残す。
  for (const k of ["CODEX_THREAD_ID", "CODEX_SESSION_ID"]) delete env[k];
  if (!("CLAUDE_CODE_SESSION_ID" in extra)) delete env.CLAUDE_CODE_SESSION_ID;
  // 自動記録は「持ち主の turn か」を親の session で決める。親のものが残っていると、検査が渡した
  // session と食い違って 1 件も積まれない（実測: フックは exit 0 のまま spool が空だった）。
  if (!("GLEANERY_PARENT_SESSION" in extra)) delete env.GLEANERY_PARENT_SESSION;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return {
    ...env,
    NODE_V8_COVERAGE: covDir,
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
  };
}

/** CLI を 1 回走らせる。落ちても止めない（到達させることが目的で、成否は呼び出し側が見る）。 */
export function runCli(args, dir, covDir, { cwd = root, ...extra } = {}) {
  const r = spawnSync("node", [path.join(root, "server/src/cli.ts"), ...args], {
    cwd,
    env: childEnv(dir, covDir, extra),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.signal === "SIGTERM" };
}

/**
 * 自動記録のフックを 1 回起動する。spool は home の下にあるので、childEnv が home を
 * 付け替えていることが前提になる（持ち主の待ち行列を読ませない）。
 */
export function runHook(input, dir, covDir, extra = {}) {
  const r = spawnSync("node", [path.join(root, "server/src/capture.ts")], {
    cwd: extra.cwd ?? root,
    env: childEnv(dir, covDir, extra),
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 一時ディレクトリを作り、終わったら消す。 */
export async function withTempDir(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-live-")));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
