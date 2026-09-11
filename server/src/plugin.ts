// 配布 plugin の版と、どこから動いているかを見る。
//
// **版を別に持たない。**正本は 3 つの manifest で、scripts/check-mcp-version.mjs が揃える。
// ここは root の `.claude-plugin/plugin.json` を読むだけ。
//
// Claude Code と Codex はどちらも plugin を `<cache>/<marketplace>/mitos/<版>/` へ複製して、
// そこから MCP を起動する。directory 型 marketplace の Claude Code（2.1.268 で観測）と
// `--plugin-dir` だけは作業ツリーを直接読む。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = path.join(".claude-plugin", "plugin.json");

/** root が mitos の配布物ならその版。消えた cache や別の plugin なら null。 */
export function versionAt(root: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return m.name === "mitos" && typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

// bundle は <root>/dist/*.js から、テストと `node src/*.ts` は server/src/ から動く。
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT =
  [path.join(here, ".."), path.join(here, "..", "..", "plugin")].find((r) => versionAt(r) !== null) ??
  path.join(here, "..");

/**
 * 起動元がまだ配布物として生きているか。
 * Codex は更新で旧版の cache を即座に消し、Claude Code は約 14 日残して `.orphaned_at` を置く。
 * **`.orphaned_at` は補助の手がかり。**公式が書くのは orphaned という扱いだけで、ファイル名は観測値。
 * 無いことを「最新」の根拠にしない。
 */
export function rootState(root: string): "gone" | "orphaned" | "ok" {
  if (!fs.existsSync(path.join(root, MANIFEST))) return "gone";
  if (fs.existsSync(path.join(root, ".orphaned_at"))) return "orphaned";
  return "ok";
}

/** MCP の応答の末尾に置く 1 行。AI がその session の実行版と、張り直しの要否を知る口。 */
export function mcpNote(version: string | null, root: string): string {
  const v = `mitos MCP ${version ?? "（版不明）"}`;
  const state = rootState(root);
  if (state === "gone")
    return `${v}。起動元 ${root} が消えている。Skill のパスも無効なので、この session を張り直す`;
  if (state === "orphaned")
    return `${v}。Claude Code がこの版を更新で置き換えた。session を張り直すと新しい版になる`;
  return v;
}

/** 0.10.9 < 0.10.18 を文字列比較で逆転させない。 */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** 2 つの root で中身が違うファイル。**mtime は見ない** — 同じ中身の再 bundle で誤検知する。 */
export function differingFiles(a: string, b: string): string[] {
  const list = (root: string) =>
    new Map(
      fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const abs = path.join(e.parentPath, e.name);
          return [path.relative(root, abs), abs] as const;
        })
        // Claude Code が置き換えた版に足す印。配布物ではない。
        .filter(([rel]) => rel !== ".orphaned_at"),
    );
  const x = list(a);
  const y = list(b);
  return [...new Set([...x.keys(), ...y.keys()])]
    .filter((rel) => {
      const p = x.get(rel);
      const q = y.get(rel);
      return !p || !q || !fs.readFileSync(p).equals(fs.readFileSync(q));
    })
    .sort();
}

export type McpProcess = { pid: number; started: Date; script: string };

/** `LC_ALL=C ps -Ao pid=,lstart=,args=` の出力から、`node …/dist/mcp.js` だけを拾う。 */
export function parsePs(out: string): McpProcess[] {
  const procs: McpProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    const script = m?.[3]?.match(/(?:^|\/)node\s+(.*\/dist\/mcp\.js)\s*$/)?.[1];
    if (m && script) procs.push({ pid: Number(m[1]), started: new Date(m[2] ?? ""), script });
  }
  return procs;
}

/** Codex は `./dist/mcp.js` を plugin root を cwd にして起動するので、相対パスは cwd で解く。 */
function cwdOf(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
  } catch {
    // /proc が無い（macOS）。
  }
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      out
        .split("\n")
        .find((l) => l.startsWith("n"))
        ?.slice(1) ?? null
    );
  } catch {
    return null;
  }
}

const CACHED = /\/plugins\/cache\/[^/]+\/mitos\/[^/]+$/;

export type Install = { version: string | null; root: string };
export type Running = { pid: number; started: Date; root: string | null; version: string | null };

export type Seen = {
  /** 作業ツリーの plugin/。cwd か CLI の置き場所が mitos の repository のときだけ見える。 */
  repository: Install | null;
  cli: Install;
  /** null は導入されていない、"unknown" は claude コマンドが使えず観測できなかった。 */
  claude: Install | null | "unknown";
  codex: Install[];
  codexCache: string;
  /** null は ps が使えず観測できなかった。 */
  running: Running[] | null;
};

/** 外部コマンドを叩く観測をここに集める。判定は report() が行い、テストは Seen を組んで渡す。 */
export function observe(cwdRoot: string): Seen {
  const install = (root: string): Install => ({ version: versionAt(root), root });

  const repository =
    [path.dirname(ROOT), cwdRoot]
      .filter((d) => fs.existsSync(path.join(d, ".claude-plugin", "marketplace.json")))
      .map((d) => install(path.join(d, "plugin")))
      .find((r) => r.version !== null) ?? null;

  let claude: Seen["claude"];
  try {
    const list = JSON.parse(
      execFileSync("claude", ["plugin", "list", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }),
    ) as { id: string; version?: string; installPath?: string }[];
    const m = list.find((p) => p.id.startsWith("mitos@"));
    claude = m?.installPath ? { version: m.version ?? null, root: m.installPath } : null;
  } catch {
    claude = "unknown";
  }

  // `codex plugin list --json` は 7 秒かかり、返る version が cache のものか source のものか
  // 区別できない。cache の置き場所を直接読む。
  const codexCache = path.join(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "plugins",
    "cache",
  );
  const codex: Install[] = [];
  for (const market of safeDirs(codexCache)) {
    for (const v of safeDirs(path.join(codexCache, market, "mitos"))) {
      codex.push(install(path.join(codexCache, market, "mitos", v)));
    }
  }

  let running: Seen["running"];
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,lstart=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    running = parsePs(out)
      .map((p): Running => {
        const base = path.isAbsolute(p.script) ? "/" : cwdOf(p.pid);
        const root = base ? path.dirname(path.dirname(path.resolve(base, p.script))) : null;
        return { pid: p.pid, started: p.started, root, version: root ? versionAt(root) : null };
      })
      // 別の plugin の dist/mcp.js を除く。消えた cache は manifest を読めないので置き場所の形で残す。
      .filter((r) => r.root === null || r.version !== null || CACHED.test(r.root))
      .map((r) => (r.root && r.version === null ? { ...r, version: path.basename(r.root) } : r));
  } catch {
    running = null;
  }

  return { repository, cli: install(ROOT), claude, codex, codexCache, running };
}

function safeDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const UPDATE = {
  claude:
    "claude plugin marketplace update mitos && claude plugin update mitos@mitos の後、session を張り直す",
  codex:
    "codex plugin marketplace upgrade mitos && codex plugin remove mitos@mitos && codex plugin add mitos@mitos の後、Codex を開き直す",
};

/**
 * doctor の plugin 節。**比較の基準は repository**（無ければ各ホストの導入済み版）で、
 * 実行中の CLI は基準にしない。古い session の PATH にある cache の CLI を基準にすると、
 * 新しいほうを「古い」と言う逆転が起きる。
 */
export function report(s: Seen, now = new Date()): string[] {
  const lines: string[] = [];
  const todo = new Set<keyof typeof UPDATE>();
  const home = os.homedir();
  const short = (p: string) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  // padEnd は全角も 1 桁に数えるので、端末の表示幅で揃える。
  const pad = (t: string, n: number) =>
    t + " ".repeat(Math.max(1, n - [...t].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0)));
  const say = (label: string, text: string) => lines.push(`${pad(`  ${label}`, 21)}${text}`);
  const row = (label: string, i: Install | null, note?: string, aside = "") =>
    say(label, `${pad(i?.version ?? "不明", 9)}${i ? short(i.root) : ""}${aside}${note ? ` ← ${note}` : ""}`);
  const base = s.repository;

  /** 基準との食い違い。同じ版なら中身まで比べる（版を上げずに変えたものを見落とさない）。 */
  const against = (i: Install): string | undefined => {
    if (!fs.existsSync(i.root)) return "導入先が無い。Skill のパスも無効";
    if (!base?.version || !i.version) return undefined;
    const c = compareVersions(i.version, base.version);
    if (c < 0) return `repository（${base.version}）より古い`;
    if (c > 0) return `repository（${base.version}）より新しい。repository の checkout が古い`;
    const diff = differingFiles(base.root, i.root);
    return diff.length
      ? `同じ版なのに中身が違う（${diff.slice(0, 3).join(", ")}${diff.length > 3 ? " など" : ""}）。版を上げずに変えたか、repository の変更がまだ配布されていない`
      : undefined;
  };

  lines.push("plugin の版");
  if (base) row("repository", base);
  else say("repository", "見えない（mitos の repository の中で実行すると比べられる）");

  row("この CLI", s.cli, against(s.cli));

  if (s.claude === "unknown") say("Claude Code", "不明（claude plugin list --json が使えない）");
  else if (s.claude === null) say("Claude Code", "導入されていない");
  else {
    const note = against(s.claude);
    if (note) todo.add("claude");
    row("Claude Code", s.claude, note);
  }

  if (s.codex.length === 0) say("Codex", `見つからない（${short(s.codexCache)} を見た）`);
  for (const x of s.codex) {
    const note = s.codex.length > 1 ? "cache が複数ある。どれを使うかは Codex が決める" : against(x);
    if (note) todo.add("codex");
    row("Codex", x, note);
  }

  // repository が見えないときの最低限: 同じ版なのに 2 つのホストで中身が違う。どちらが古いかは断定しない。
  if (!base && s.claude !== "unknown" && s.claude?.version && s.codex.length === 1) {
    const x = s.codex[0];
    if (x?.version === s.claude.version && differingFiles(s.claude.root, x.root).length) {
      lines.push("  ← Claude Code と Codex で同じ版なのに中身が違う");
    }
  }

  if (s.running === null) say("実行中の MCP", "不明（ps が使えない）");
  else if (s.running.length === 0) say("実行中の MCP", "無い");
  for (const r of s.running ?? []) {
    const when = r.started
      .toLocaleString("sv-SE")
      .slice(r.started.toDateString() === now.toDateString() ? 11 : 5, 16);
    const label = `MCP pid ${r.pid}`;
    const aside = `（${when} 起動）`;
    if (!r.root) {
      row(label, null, "起動元が分からない", aside);
      continue;
    }
    const codex = r.root.startsWith(`${s.codexCache}/`);
    const installed = codex ? (s.codex.length === 1 ? s.codex[0] : undefined) : s.claude;
    const state = rootState(r.root);
    let note: string | undefined;
    if (state === "gone") note = "起動元が消えている。Skill のパスも無効なので、この session を張り直す";
    else if (!CACHED.test(r.root)) {
      note =
        "配布された cache ではなく、この場所を直接読んでいる（directory 型 marketplace か --plugin-dir）";
    } else if (state === "orphaned") note = "Claude Code が更新で置き換えた版。session を張り直す";
    else if (installed && installed !== "unknown" && installed.version && r.version) {
      if (compareVersions(r.version, installed.version) < 0)
        note = `導入済みの ${installed.version} より古い。session を張り直す`;
    }
    row(label, { version: r.version, root: r.root }, note, aside);
  }

  if (todo.size) {
    lines.push("  更新するには:");
    for (const k of todo) lines.push(`    ${k === "claude" ? "Claude Code" : "Codex"}: ${UPDATE[k]}`);
    lines.push(
      "    届く中身は各ホストの marketplace の取得元で決まる。GitHub から取る設定なら、push していない変更は届かない",
    );
  }
  return lines;
}
