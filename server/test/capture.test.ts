import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { answersOf, fit, isOwnerTurn, MAX_MESSAGE, onHook, type Spooled, spoolDir } from "../src/capture.ts";
import { bytes, mask } from "../src/text.ts";

// 別の agent 向けの prompt が「持ち主の発言」として DB の大半を占めた先行事例がある。見分けに推測を使わない。
test("subagent と、エージェントが起動した子と、印を継がない headless の turn は持ち主の発言にしない", () => {
  assert.equal(isOwnerTurn({ session_id: "s1" }, undefined, "cli"), true, "人が打つ session");
  assert.equal(isOwnerTurn({ session_id: "s1" }, "s1", "cli"), true, "自分が書いた印は自分の id と一致する");
  assert.equal(isOwnerTurn({ session_id: "child" }, "s1", "sdk-cli"), false, "親の印を継いだ子");
  assert.equal(isOwnerTurn({ session_id: "s1" }, "none", "sdk-cli"), false, "mitos が起動した headless");
  assert.equal(
    isOwnerTurn({ session_id: "s1" }, undefined, "sdk-cli"),
    false,
    "launchd や Codex から起動した claude -p",
  );
  assert.equal(isOwnerTurn({ session_id: "s1", agent_id: "a1" }, undefined, "cli"), false, "subagent");
  assert.equal(isOwnerTurn({}, undefined, "cli"), false, "session の分からない入力");
});

test("128 KiB を超えた発言は冒頭と末尾だけを残し、元の大きさを持つ", () => {
  const small = fit("短い");
  assert.deepEqual(small, { body: "短い", truncated: false, originalBytes: bytes("短い") });
  const big = `${"頭".repeat(20_000)}${"中".repeat(50_000)}${"尾".repeat(20_000)}`;
  const got = fit(big);
  assert.equal(got.truncated, true);
  assert.equal(got.originalBytes, bytes(big));
  assert.ok(bytes(got.body) < 20 * 1024, `${bytes(got.body)} bytes 残っている`);
  assert.ok(got.body.startsWith("頭") && got.body.endsWith("尾"));
  assert.match(got.body, /中央 [\d,]+ bytes を保存していない/);
  assert.ok(bytes(big) > MAX_MESSAGE);
});

test("形の決まった鍵だけを伏せ、接続文字列はパスワードだけを伏せる", () => {
  const got = mask(
    [
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123",
      "VOYAGE=pa-abcdefghijklmnopqrstuvwxyz0123",
      "gh: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "url: postgres://mitos_reader:s3cr3t@ep-x.neon.tech/db",
      "ふつうの文: sk は短いので伏せない、pa-ge も伏せない",
    ].join("\n"),
  );
  for (const leak of ["sk-proj-abc", "pa-abcdef", "ghp_abc", "s3cr3t"])
    assert.ok(!got.includes(leak), `${leak} が残った`);
  assert.match(got, /postgres:\/\/mitos_reader:\[伏せた\]@ep-x\.neon\.tech\/db/);
  assert.match(got, /ふつうの文: sk は短いので伏せない、pa-ge も伏せない/);
});

// レビューで素通りを再現した形。代入の名前で分かるもの、接頭辞の決まったもの、@ を含むパスワード。
test("よく貼られる鍵の形と、名前で分かる代入を伏せる", () => {
  const cases = [
    "PGPASSWORD=npg_AbCdEf123456",
    "npg_AbCdEf123456XY を貼った",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123456",
    "Authorization: Bearer 0123456789abcdefghijABCDEFGHIJ",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "glpat-abcdefghij1234567890",
    "rk_live_abcdefghijklmnop1234",
    "whsec_abcdefghijklmnopqrstuvwxyz",
    '{"password": "hunter2-example"}',
    "postgresql://neondb_owner:ab@cdEFGH123@ep-x.neon.tech/neondb",
  ];
  const secrets = [
    "npg_AbCdEf",
    "wJalrXUtn",
    "eyJhbGci",
    "0123456789abcdefghij",
    "AIzaSy",
    "npm_abc",
    "glpat-",
    "rk_live_",
    "whsec_",
    "hunter2",
    "ab@cdEFGH",
  ];
  const got = cases.map(mask).join("\n");
  for (const leak of secrets) assert.ok(!got.includes(leak), `${leak} が残った:\n${got}`);
  assert.match(got, /@ep-x\.neon\.tech\/neondb/, "どこへ繋いだかは残す");
  const plain = "max_tokens: 5000 と keyboard の key の話。const token = await getToken();";
  assert.equal(mask(plain), plain, "鍵でない文は変えない");
});

// 伏せた文は元に戻せない。コードの型注釈や変数の参照を鍵とみなして消すと、会話の中身が失われる。
test("鍵でない代入と URL は変えず、残りの形（ヘッダ・mysql -p・ユーザー名の無い URL）は伏せる", () => {
  for (const code of [
    "password: string;",
    "const token = await getToken();",
    "apiKey: process.env.API_KEY",
    "PASSWORD=$DB_PASSWORD",
    "MONKEY=banana TURKEY=roast COMPASS=north",
    "http://localhost:5173/@vite/client",
    "see https://github.com/o/r/pull/3",
    "refresh token server/src/http/routes/knowledge.ts を読んだ",
    "the basic src/components/app-sidebar.tsx layout",
    "--brand-token: #ff00aa11;",
    "PWD=/Users/someone/Projects/x PASS=3 FAIL=0",
  ])
    assert.equal(mask(code), code, code);
  const got = [
    "Authorization: Basic YWRtaW46c3dvcmRmaXNoMTIz",
    "X-API-Key: ak_9f8e7d6c5b4a3",
    "DB_PASS=s3cr3t-value",
    "mysql -u root -phunter2x db",
    "redis://:hunter2x@cache:6379",
    "authorization: bearer abcdefghijklmnopqrstuvwxyz",
    'PASSWORD="correct horse battery staple"',
    "AccountKey=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==",
    'password: "correcthorsebatterystaple"',
    "client_secret: 'zyxwvutsrqponmlkjihg'",
    "MASTERKEY=m4sterv4lue99 ENCRYPTIONKEY=0123456789abcdef",
  ]
    .map(mask)
    .join("\n");
  for (const leak of [
    "YWRtaW46",
    "ak_9f8e7d",
    "s3cr3t",
    "hunter2x",
    "abcdefghijklmnop",
    "horse",
    "AbCdEfGh",
    "zyxwvuts",
    "m4sterv4lue",
    "0123456789abcdef",
  ])
    assert.ok(!got.includes(leak), `${leak}:\n${got}`);
  assert.match(got, /@cache:6379/);
});

// 伏せ字は発言の全文へかける。引き金を繰り返しただけの入力で、フックが何秒も止まらない。
test("伏せ字は引き金を繰り返した入力でも線形に終わる", () => {
  const N = 128 * 1024;
  for (const unit of [
    "postgres://u:",
    "-----BEGIN RSA PRIVATE KEY-----",
    "password: a1",
    "Bearer ",
    "eyJabcdefgh.",
    "a-",
    "0f8fad5b-d9cb-469f-a165-70867728950e",
    "mysql ",
    "token=",
    "Authorization: Bearer ",
  ]) {
    const text = unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    const t = performance.now();
    mask(text);
    assert.ok(performance.now() - t < 300, `${unit}: ${(performance.now() - t).toFixed(0)} ms`);
  }
});

test("AskUserQuestion の答えを、質問と答えの組にする", () => {
  assert.equal(
    answersOf({ tool_response: { answers: { "全部推奨で？": "推奨", 選ぶもの: ["A", "B"] } } }),
    "Q: 全部推奨で？\nA: 推奨\n\nQ: 選ぶもの\nA: A / B",
  );
  assert.equal(
    answersOf({
      tool_response: { answers: { 進め方: "推奨" }, annotations: { 進め方: { notes: "全部推奨で" } } },
    }),
    "Q: 進め方\nA: 推奨\nメモ: 全部推奨で",
  );
  assert.equal(answersOf({ tool_response: {} }), null);
  assert.equal(
    answersOf({ tool_input: { answers: { 質問: "モデルが書いた答え" } } }),
    null,
    "入力側の答えは使わない",
  );
});

// ---- フックの入力から待ち行列までを通す ----

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mitos-capture-home-")));
const realHome = process.env.HOME;
const repoDir = path.join(home, "repo");
before(() => {
  // この試験を Claude Code の Bash から走らせると、親の session の印と入口を継いでいる。
  delete process.env.MITOS_PARENT_SESSION;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.HOME = home;
  execFileSync("git", ["init", "-q", repoDir], { stdio: "ignore" });
  fs.mkdirSync(path.join(repoDir, "server"));
  execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/o/r.git"], {
    stdio: "ignore",
  });
});
after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const spooled = (): Spooled[] => {
  const dir = spoolDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Spooled);
};
const reset = () => fs.rmSync(spoolDir(), { recursive: true, force: true });

test("持ち主の発言・AI の最後の応答・編集したファイルが待ち行列に入る", () => {
  reset();
  const base = { session_id: "s1", prompt_id: "p1", cwd: path.join(repoDir, "server") };
  onHook("claude-code", {
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt: "DB を作り直す。鍵は sk-proj-abcdefghijklmnopqrstuvwxyz0123",
  });
  onHook("claude-code", {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(repoDir, "db", "schema.sql") },
  });
  // リポジトリの外と、承認済みの成果物でない読み込みは残さない。
  onHook("claude-code", {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/etc/hosts" },
  });
  onHook("claude-code", {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
  });
  onHook("claude-code", {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(repoDir, ".mitos/changes/auth/design.md") },
  });
  const r = onHook("claude-code", {
    ...base,
    hook_event_name: "Stop",
    last_assistant_message: "作り直した。",
  });
  assert.equal(r.flush, true, "Stop で送る");
  const got = spooled();
  const messages = got.filter((x) => x.kind === "message");
  const files = got.filter((x) => x.kind === "file");
  assert.deepEqual(
    messages.map((m) => (m.kind === "message" ? [m.id, m.speaker, m.project] : [])),
    [
      ["p1:self", "self", "git:github.com/o/r"],
      ["p1:assistant", "assistant", "git:github.com/o/r"],
    ],
  );
  const said = messages[0];
  assert.ok(said?.kind === "message" && !said.body.includes("sk-proj-abc"), "鍵が待ち行列に入った");
  assert.deepEqual(
    files.map((f) => (f.kind === "file" ? [f.path, f.action] : [])),
    [
      ["db/schema.sql", "edit"],
      [".mitos/changes/auth/design.md", "read"],
    ],
  );
});

test("エージェントが起動した子と、作業場所の外の session は何も書かない", () => {
  reset();
  process.env.MITOS_PARENT_SESSION = "parent";
  try {
    onHook("claude-code", {
      session_id: "child",
      prompt_id: "p",
      cwd: repoDir,
      hook_event_name: "UserPromptSubmit",
      prompt: "レビューして",
    });
  } finally {
    delete process.env.MITOS_PARENT_SESSION;
  }
  onHook("claude-code", {
    session_id: "s2",
    prompt_id: "p",
    cwd: os.tmpdir(),
    hook_event_name: "UserPromptSubmit",
    prompt: "外",
  });
  assert.deepEqual(spooled(), []);
});

test("SessionStart は、この session の id を子へ継がせる", () => {
  const file = path.join(home, "env-file");
  fs.writeFileSync(file, "");
  process.env.CLAUDE_ENV_FILE = file;
  try {
    onHook("claude-code", { session_id: "abc-123", hook_event_name: "SessionStart" });
    // 形の違う id はシェルへ書かない（CLAUDE_ENV_FILE はシェルで読まれる）。
    onHook("claude-code", { session_id: "x; rm -rf ~", hook_event_name: "SessionStart" });
  } finally {
    delete process.env.CLAUDE_ENV_FILE;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "export MITOS_PARENT_SESSION=abc-123\n");
});

test("Codex の apply_patch は見出しから編集先を読む", () => {
  reset();
  onHook("codex", {
    session_id: "t1",
    turn_id: "turn-1",
    cwd: repoDir,
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: server/src/a.ts\n@@\n+x\n*** End Patch" },
  });
  const got = spooled();
  assert.equal(got.length, 1);
  assert.ok(got[0]?.kind === "file" && got[0].path === "server/src/a.ts" && got[0].host === "codex");
});
