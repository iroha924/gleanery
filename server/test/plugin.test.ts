import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadEnv } from "../src/db.ts";
import {
  compareVersions,
  differingFiles,
  type Install,
  mcpNote,
  parsePs,
  report,
  rootState,
  type Seen,
  versionAt,
} from "../src/plugin.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const REPO_PLUGIN = path.join(SRC, "..", "..", "plugin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-plugin-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
/** manifest と中身 1 つだけの配布物を作る。 */
function plugin(where: string, version: string, body = "x"): Install {
  const root = path.join(tmp, where);
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "mitos", version }),
  );
  fs.writeFileSync(path.join(root, "dist", "mcp.js"), body);
  return { version, root };
}

const seen = (over: Partial<Seen>): Seen => ({
  repository: null,
  cli: plugin("cli", "0.10.19"),
  claude: null,
  codex: [],
  codexCache: path.join(tmp, "codex", "plugins", "cache"),
  running: [],
  ...over,
});

test("版は数値で比べる（0.10.9 < 0.10.18）", () => {
  assert.equal(compareVersions("0.10.9", "0.10.18"), -1);
  assert.equal(compareVersions("0.10.18", "0.10.18"), 0);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("mitos 以外の manifest と消えた root は版を持たない", () => {
  const other = path.join(tmp, "other");
  fs.mkdirSync(path.join(other, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(other, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "x", version: "1.0.0" }),
  );
  assert.equal(versionAt(other), null);
  assert.equal(versionAt(path.join(tmp, "missing")), null);
  assert.equal(versionAt(plugin("ok", "0.1.0").root), "0.1.0");
});

test("起動元が消えたら Skill のパスも無効と伝え、置き換え済みなら張り直しを促す", () => {
  const live = plugin("live", "0.10.18");
  assert.equal(rootState(live.root), "ok");
  assert.equal(mcpNote("0.10.18", live.root), "mitos MCP 0.10.18");

  const old = plugin("orphaned", "0.10.17");
  fs.writeFileSync(path.join(old.root, ".orphaned_at"), "1789000000000");
  assert.equal(rootState(old.root), "orphaned");
  assert.match(
    mcpNote("0.10.17", old.root),
    /置き換えた。\/reload-plugins か session の張り直しで新しい版になる/,
  );

  const gone = path.join(tmp, "gone", "0.10.16");
  assert.equal(rootState(gone), "gone");
  assert.match(mcpNote("0.10.16", gone), /^mitos MCP 0\.10\.16。起動元 .* が消えている。Skill のパスも無効/);
});

test("中身の比較はホストが cache に足す印と .DS_Store を無視する", () => {
  const a = plugin("same-a", "0.1.0");
  const b = plugin("same-b", "0.1.0");
  // Claude Code は置き換えた版に .orphaned_at を、使っている版に .in_use/<pid> を置く。
  fs.writeFileSync(path.join(b.root, ".orphaned_at"), "1");
  fs.mkdirSync(path.join(b.root, ".in_use"));
  fs.writeFileSync(path.join(b.root, ".in_use", "18278"), "");
  fs.writeFileSync(path.join(a.root, "dist", ".DS_Store"), "");
  assert.deepEqual(differingFiles(a.root, b.root), []);
  fs.writeFileSync(path.join(b.root, "dist", "mcp.js"), "y");
  fs.mkdirSync(path.join(a.root, "skills", "new"), { recursive: true });
  fs.writeFileSync(path.join(a.root, "skills", "new", "SKILL.md"), "s");
  assert.deepEqual(differingFiles(a.root, b.root), ["dist/mcp.js", "skills/new/SKILL.md"]);
});

test("ps の出力から node …/dist/mcp.js だけを拾う", () => {
  const out = [
    "18319 Fri Sep 11 09:07:27 2026     node /Users/me/Projects/mitos/plugin/dist/mcp.js",
    "29334 Fri Sep  4 14:10:31 2026     node ./dist/mcp.js",
    "  401 Fri Sep 11 09:00:00 2026     /opt/homebrew/bin/node /Users/me/Library/Application Support/x/dist/mcp.js",
    "  500 Fri Sep 11 09:00:00 2026     node /Users/me/other/dist/cli.js",
    "  501 Fri Sep 11 09:00:00 2026     vim dist/mcp.js",
  ].join("\n");
  const got = parsePs(out);
  assert.deepEqual(
    got.map((p) => [p.pid, p.script]),
    [
      [18319, "/Users/me/Projects/mitos/plugin/dist/mcp.js"],
      [29334, "./dist/mcp.js"],
      [401, "/Users/me/Library/Application Support/x/dist/mcp.js"],
    ],
  );
  assert.equal(got[1]?.started.getDate(), 4);
});

test("repository より古い導入は両ホストとも更新手順を出す", () => {
  const repository = plugin("r1/plugin", "0.10.19");
  const out = report(
    seen({
      repository,
      cli: repository,
      claude: plugin("claude/plugins/cache/mitos/mitos/0.10.18", "0.10.18"),
      codex: [plugin("codex/plugins/cache/mitos/mitos/0.10.18", "0.10.18")],
    }),
  ).join("\n");
  assert.match(out, /Claude Code .*← repository（0\.10\.19）より古い/);
  assert.match(out, /Codex .*← repository（0\.10\.19）より古い/);
  assert.match(
    out,
    /Claude Code: claude plugin marketplace update mitos && claude plugin update mitos@mitos/,
  );
  assert.match(out, /開いている session で \/reload-plugins/);
  assert.match(
    out,
    /Codex: codex plugin marketplace upgrade mitos && codex plugin add mitos@mitos の後、Codex を開き直す/,
  );
});

test("古い cache の CLI から実行しても、新しい導入を古いと言わない", () => {
  // 古い session の PATH には置き換え前の cache の bin/ が残る。CLI を基準にすると向きが逆転する。
  const repository = plugin("r2/plugin", "0.10.19");
  const out = report(
    seen({
      repository,
      cli: plugin("claude/plugins/cache/mitos/mitos/0.10.18b", "0.10.18"),
      claude: plugin("claude/plugins/cache/mitos/mitos/0.10.19", "0.10.19"),
    }),
  );
  assert.match(out.find((l) => l.includes("この CLI")) ?? "", /← repository（0\.10\.19）より古い/);
  assert.doesNotMatch(out.find((l) => l.includes("Claude Code")) ?? "", /←/);
  assert.ok(!out.some((l) => l.includes("更新するには")));
});

test("同じ版で中身が違えば、repository の CLI だけ新しい状態として出す", () => {
  const repository = plugin("r3/plugin", "0.10.18", "new");
  const out = report(
    seen({
      repository,
      cli: repository,
      codex: [plugin("codex/plugins/cache/mitos/mitos/0.10.18c", "0.10.18", "old")],
    }),
  ).join("\n");
  assert.match(
    out,
    /Codex .*同じ版なのに中身が違う（dist\/mcp\.js）。repository の変更は、版を上げて main へ入れるまで届かない/,
  );
  // cache は版が変わったときだけ複製し直されるので、ホストを更新しても変わらない。
  assert.doesNotMatch(out, /更新するには/);
});

test("導入側のほうが新しければ、更新手順を出さず checkout が古いと言う", () => {
  const out = report(
    seen({
      repository: plugin("r4/plugin", "0.10.18"),
      claude: plugin("claude4/plugins/cache/mitos/mitos/0.10.19", "0.10.19"),
    }),
  ).join("\n");
  assert.match(out, /Claude Code .*← repository（0\.10\.18）より新しい。repository の checkout が古い/);
  assert.doesNotMatch(out, /更新するには/);
});

test("repository が見えず Claude の導入先が消えていても落ちない", () => {
  const out = report(
    seen({
      claude: { version: "0.10.18", root: path.join(tmp, "claude5", "missing") },
      codex: [plugin("codex5/plugins/cache/mitos/mitos/0.10.18", "0.10.18")],
    }),
  ).join("\n");
  assert.match(out, /Claude Code .*← 導入先が無い/);
});

test("実行中の MCP は起動元の状態と導入済みの版で判定する", () => {
  const installed = plugin("claude2/plugins/cache/mitos/mitos/0.10.19", "0.10.19");
  const older = plugin("claude2/plugins/cache/mitos/mitos/0.10.18", "0.10.18");
  const replaced = plugin("claude2/plugins/cache/mitos/mitos/0.10.17", "0.10.17");
  fs.writeFileSync(path.join(replaced.root, ".orphaned_at"), "1");
  const codexCache = path.join(tmp, "codex2", "plugins", "cache");
  const started = new Date("2026-09-11T00:07:27Z");
  const out = report(
    seen({
      claude: installed,
      codexCache,
      running: [
        { pid: 1, started, root: installed.root, version: "0.10.19" },
        { pid: 2, started, root: older.root, version: "0.10.18" },
        { pid: 3, started, root: replaced.root, version: "0.10.17" },
        { pid: 4, started, root: path.join(codexCache, "mitos", "mitos", "0.10.16"), version: "0.10.16" },
        { pid: 5, started, root: plugin("work/plugin", "0.10.19").root, version: "0.10.19" },
        // 同じパスに作り直された cache。パスは生きているが、動いているのは消えた旧ディレクトリの中身。
        {
          pid: 6,
          started,
          root: plugin("codex2/plugins/cache/mitos/mitos/0.10.15", "0.10.15").root,
          version: "0.10.15",
          replaced: true,
        },
      ],
    }),
  );
  const line = (pid: number) => out.find((l) => l.includes(`MCP pid ${pid} `)) ?? "";
  assert.doesNotMatch(line(1), /←/);
  assert.match(line(2), /← 導入済みの 0\.10\.19 より古い。\/reload-plugins か session の張り直しで直す/);
  assert.match(line(3), /← Claude Code が更新で置き換えた版/);
  assert.match(line(4), /← 起動元が消えている。Skill のパスも無効なので、Codex の開き直しで直す/);
  assert.match(line(5), /← 配布された cache ではなく、この場所を直接読んでいる/);
  assert.match(
    line(6),
    /← 起動元が同じ場所に作り直され、消えた旧版の中身で動いている。Codex の開き直しで直す/,
  );
});

test("導入先が消えていれば repository が見えなくても出す", () => {
  const out = report(
    seen({ claude: { version: "0.10.18", root: path.join(tmp, "claude3", "missing") } }),
  ).join("\n");
  assert.match(out, /Claude Code .*← 導入先が無い。Skill のパスも無効/);
  assert.match(out, /Claude Code: claude plugin marketplace update mitos/);
});

test("観測できないものは無いと言わず不明と出す", () => {
  const out = report(seen({ claude: "unknown", running: null })).join("\n");
  assert.match(out, /Claude Code\s+不明/);
  assert.match(out, /実行中の MCP\s+不明/);
  assert.match(out, /repository\s+見えない/);
  assert.match(out, /Codex\s+見つからない/);
});

test("mitos --version は manifest の版を出す", () => {
  const out = execFileSync(process.execPath, [path.join(SRC, "cli.ts"), "--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
  });
  assert.equal(out.trim().split(/\s+/)[0], versionAt(REPO_PLUGIN));
});

test("MCP の serverInfo は manifest の版を名乗る", async () => {
  // 資格情報なしで通る initialize だけを見る。ツールの応答は次のテストで DB へ繋いで見る。
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp.ts")],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
      stderr: "ignore",
    }),
  );
  try {
    assert.equal(client.getServerVersion()?.version, versionAt(REPO_PLUGIN));
  } finally {
    await client.close();
  }
});

// **読み取り用の鍵を自分で選ばない。**current-work.test.ts と同じく、RO が無ければ飛ばす。
const hasRo = (() => {
  try {
    return Boolean(loadEnv().KNOWLEDGE_DB_URL_RO);
  } catch {
    return false;
  }
})();

test("current_work の応答は記録の枠の外に実行版を添える", {
  skip: hasRo ? false : "KNOWLEDGE_DB_URL_RO が無い",
}, async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp.ts")],
      stderr: "ignore",
    }),
  );
  try {
    // 未登録の場所で返す早期の応答と、記録を quote() の枠に入れて返す応答の両方を通す。
    for (const cwd of [os.tmpdir(), path.join(SRC, "..", "..")]) {
      const r = await client.callTool({ name: "current_work", arguments: { cwd } });
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      assert.equal(text.split("\n").at(-1), `mitos MCP ${versionAt(REPO_PLUGIN)}`, cwd);
      assert.ok(text.lastIndexOf("ここまで") < text.lastIndexOf("mitos MCP"), `枠の中に入っている: ${cwd}`);
    }
  } finally {
    await client.close();
  }
});
