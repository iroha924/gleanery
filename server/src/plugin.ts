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
    return `${v}。起動元 ${root} が消えている。Skill のパスも無効なので、Claude Code は /reload-plugins、Codex は開き直すと新しい版になる`;
  if (state === "orphaned")
    return `${v}。Claude Code がこの版を更新で置き換えた。/reload-plugins か session の張り直しで新しい版になる`;
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
        // ホストが cache に書き足す印（Claude Code の `.orphaned_at` と `.in_use/<pid>`）と `.DS_Store` は
        // 配布物ではない。root 直下でドットから始まる配布物は manifest の 2 つだけ。
        .filter(([rel]) => {
          const top = rel.split(path.sep)[0] ?? "";
          const mark = top.startsWith(".") && top !== ".claude-plugin" && top !== ".codex-plugin";
          return !mark && path.basename(rel) !== ".DS_Store";
        }),
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

/** `LC_ALL=C ps -o pid=,lstart=,args=` の出力から、`node …/dist/mcp.js` だけを拾う。 */
export function parsePs(out: string): McpProcess[] {
  const procs: McpProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    const script = m?.[3]?.match(/(?:^|\/)node\s+(.*\/dist\/mcp\.js)\s*$/)?.[1];
    if (m && script) procs.push({ pid: Number(m[1]), started: new Date(m[2] ?? ""), script });
  }
  return procs;
}

/**
 * Codex は `./dist/mcp.js` を plugin root を cwd にして起動するので、相対パスは cwd で解く。
 * **同じパスに作り直された cache を生きていると読まない。**プロセスが握る cwd は消えた旧ディレクトリの
 * ままなので、Linux は ` (deleted)` の印、macOS は inode の食い違いで見分ける。
 */
function cwdOf(pid: number): { dir: string; replaced: boolean } | null {
  try {
    const link = fs.readlinkSync(`/proc/${pid}/cwd`);
    return { dir: link.replace(/ \(deleted\)$/, ""), replaced: link.endsWith(" (deleted)") };
  } catch {
    // /proc が無い（macOS）。
  }
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const field = (k: string) =>
      out
        .split("\n")
        .find((l) => l.startsWith(k))
        ?.slice(1);
    const dir = field("n");
    if (!dir) return null;
    let now: string | undefined;
    try {
      now = String(fs.statSync(dir).ino);
    } catch {
      // 消えていれば rootState() が拾う。
    }
    const held = field("i");
    return { dir, replaced: now !== undefined && held !== undefined && now !== held };
  } catch {
    return null;
  }
}

const CACHED = /\/plugins\/cache\/[^/]+\/mitos\/[^/]+$/;

export type Install = { version: string | null; root: string };
export type Running = {
  pid: number;
  started: Date;
  root: string | null;
  version: string | null;
  /** 同じパスに作り直された起動元から、消えた旧ディレクトリの中身で動いている。 */
  replaced?: boolean;
};

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
    ) as {
      id: string;
      version?: string;
      installPath?: string;
      scope?: string;
      enabled?: boolean;
      projectPath?: string;
    }[];
    // 同じ id が scope ごとに並ぶ。project と local は別の場所の導入なので、この場所のものか user を採る。
    const mine = list.filter((p) => p.id.startsWith("mitos@") && p.enabled !== false);
    const m = mine.find((p) => p.projectPath === cwdRoot) ?? mine.find((p) => p.scope === "user");
    claude = m?.installPath ? { version: m.version ?? null, root: m.installPath } : null;
  } catch {
    claude = "unknown";
  }

  // `codex plugin list --json` は 7 秒かかり、返る version が cache のものか source のものか
  // 区別できない。cache の置き場所を直接読む。
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  // lsof は symlink を解いたパスを返すので、実行中の MCP と突き合わせる側も解いておく。
  let codexCache = path.join(codexHome, "plugins", "cache");
  try {
    codexCache = fs.realpathSync(codexCache);
  } catch {
    // 無ければ下の走査が空になり、「見つからない」と出る。
  }
  const codex: Install[] = [];
  for (const market of safeDirs(codexCache)) {
    for (const v of safeDirs(path.join(codexCache, market, "mitos"))) {
      codex.push(install(path.join(codexCache, market, "mitos", v)));
    }
  }

  let running: Seen["running"];
  try {
    const out = execFileSync("ps", ["-U", String(process.getuid?.()), "-o", "pid=,lstart=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
    });
    running = parsePs(out).flatMap((p): Running[] => {
      const cwd = path.isAbsolute(p.script) ? { dir: "/", replaced: false } : cwdOf(p.pid);
      if (!cwd) return [{ pid: p.pid, started: p.started, root: null, version: null }];
      const root = path.dirname(path.dirname(path.resolve(cwd.dir, p.script)));
      const cached = CACHED.test(root);
      const now = versionAt(root);
      // 別の plugin の dist/mcp.js を除く。消えた cache は manifest を読めないので置き場所の形で見分ける。
      if (now === null && !cached) return [];
      // 表示するのは起動時の版。消えた・作り直された cache はディレクトリ名がそれにあたる。作業ツリーは
      // 起動後も書き換わるので、bundle が起動より新しければ今の manifest の版で動いているとは言えない。
      let version = cwd.replaced || now === null ? (cached ? path.basename(root) : null) : now;
      if (!cached && version !== null) {
        try {
          if (fs.statSync(path.join(root, "dist", "mcp.js")).mtimeMs > p.started.getTime()) version = null;
        } catch {
          version = null;
        }
      }
      return [{ pid: p.pid, started: p.started, root, version, replaced: cwd.replaced }];
    });
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

// `plugin update` は marketplace を取り直すと公式に書かれていないので、先に取り直す。
// 更新後も動いている MCP は旧版のパスのまま。Claude Code は対話端末の session なら
// /reload-plugins で新しいパスへ移る（公式 plugins-reference）。Codex は開き直す。
const UPDATE = {
  claude:
    "claude plugin marketplace update mitos && claude plugin update mitos@mitos の後、開いている session で /reload-plugins",
  codex: "codex plugin marketplace upgrade mitos && codex plugin add mitos@mitos の後、Codex を開き直す",
};
const RELOAD = { claude: "/reload-plugins か session の張り直し", codex: "Codex の開き直し" };

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

  /**
   * 基準との食い違いと、ホストの更新で直るか。同じ版なら中身まで比べる（版を上げずに変えたものを見落とさない）。
   * 導入側が新しいときと、同じ版で中身だけ違うときは、更新しても変わらないので手順を出さない
   * （cache は版が変わったときだけ複製し直される）。
   */
  const against = (i: Install): { note?: string; update?: boolean } => {
    if (!fs.existsSync(i.root)) return { note: "導入先が無い。Skill のパスも無効", update: true };
    if (!base?.version || !i.version) return {};
    const c = compareVersions(i.version, base.version);
    if (c < 0) return { note: `repository（${base.version}）より古い`, update: true };
    if (c > 0) return { note: `repository（${base.version}）より新しい。repository の checkout が古い` };
    const diff = differingFiles(base.root, i.root);
    if (!diff.length) return {};
    const files = `${diff.slice(0, 3).join(", ")}${diff.length > 3 ? " など" : ""}`;
    return {
      note: `同じ版なのに中身が違う（${files}）。repository の変更は、版を上げて main へ入れるまで届かない`,
    };
  };

  lines.push("plugin の版");
  if (base) row("repository", base);
  else say("repository", "見えない（mitos の repository の中で実行すると比べられる）");

  row("この CLI", s.cli, against(s.cli).note);

  if (s.claude === "unknown") say("Claude Code", "不明（claude plugin list --json が使えない）");
  else if (s.claude === null) say("Claude Code", "導入されていない");
  else {
    const { note, update } = against(s.claude);
    if (update) todo.add("claude");
    row("Claude Code", s.claude, note);
  }

  if (s.codex.length === 0) say("Codex", `見つからない（${short(s.codexCache)} を見た）`);
  for (const x of s.codex) {
    // 入れ直すと Codex は旧版の cache を消す（codex-cli 0.153.4 で観測）。
    const { note, update } =
      s.codex.length > 1
        ? { note: "cache が複数ある。どれを使うかは Codex が決める", update: true }
        : against(x);
    if (update) todo.add("codex");
    row("Codex", x, note);
  }

  // repository が見えないときの最低限: 同じ版なのに 2 つのホストで中身が違う。どちらが古いかは断定しない。
  const x = s.codex.length === 1 ? s.codex[0] : undefined;
  if (!base && s.claude && s.claude !== "unknown" && x && s.claude.version === x.version) {
    if (fs.existsSync(s.claude.root) && differingFiles(s.claude.root, x.root).length) {
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
    const again = RELOAD[codex ? "codex" : "claude"];
    const state = rootState(r.root);
    let note: string | undefined;
    if (state === "gone") note = `起動元が消えている。Skill のパスも無効なので、${again}で直す`;
    else if (r.replaced) note = `起動元が同じ場所に作り直され、消えた旧版の中身で動いている。${again}で直す`;
    else if (!CACHED.test(r.root)) {
      note =
        "配布された cache ではなく、この場所を直接読んでいる（directory 型 marketplace か --plugin-dir）";
    } else if (state === "orphaned") note = `Claude Code が更新で置き換えた版。${again}で直す`;
    else if (installed && installed !== "unknown" && installed.version && r.version) {
      if (compareVersions(r.version, installed.version) < 0)
        note = `導入済みの ${installed.version} より古い。${again}で直す`;
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
