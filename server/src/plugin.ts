// npm packageと配布pluginのバージョン、それぞれがどこから動いているかを見る。
//
// Claude Code と Codex はどちらも plugin を `<cache>/<marketplace>/gleanery/<バージョン>/` へ複製して、
// そこから MCP を起動する。directory 型 marketplace の Claude Code（2.1.268 で観測）と
// `--plugin-dir` だけは作業ツリーを直接読む。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caution, faint, type Mark, mark, pad, width } from "./panel.ts";

const MANIFEST = path.join(".claude-plugin", "plugin.json");
const PACKAGE = "package.json";

/** root が gleanery の配布物ならそのバージョン。消えた cache や別の plugin なら null。 */
export function versionAt(root: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return m.name === "gleanery" && typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

/** root が gleanery のnpm packageならそのバージョン。plugin channelのバージョンとは独立して進みうる。 */
export function packageVersionAt(root: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, PACKAGE), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return m.name === "gleanery" && typeof m.version === "string" ? m.version : null;
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
 * Codex は更新で旧バージョンの cache を即座に消し、Claude Code は約 14 日残して `.orphaned_at` を置く。
 * **`.orphaned_at` は補助の手がかり。**公式が書くのは orphaned という扱いだけで、ファイル名は観測値。
 * 無いことを「最新」の根拠にしない。
 */
export function rootState(root: string): "gone" | "orphaned" | "ok" {
  if (!fs.existsSync(path.join(root, MANIFEST))) return "gone";
  if (fs.existsSync(path.join(root, ".orphaned_at"))) return "orphaned";
  return "ok";
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

// Claude Code が cache の root に書き足す印（置き換えたバージョンの `.orphaned_at`、使っているバージョンの `.in_use/<pid>`）。
// **名前で挙げる。**ドットで始まるものをまとめて外すと、`.mcp.json` のような配布物の差まで黙って消える。
const HOST_MARKS = new Set([".orphaned_at", ".in_use"]);

/**
 * bundle が作り、npm が配るが、git は追跡しないもの。
 * **ディレクトリだけでなくファイルも挙げる** — 同梱の告知を入れ忘れて、正常な導入先が
 * 「同じバージョンなのに中身が違う」と出た（実測: 自己比較で THIRD_PARTY_NOTICES.md だけが差になった）。
 */
const GENERATED = /^(dist|db)\/|^THIRD_PARTY_NOTICES\.md$/;

/** OS と editor が置く物。追跡もされず、npm にも詰められない。 */
const JUNK = /^\.DS_Store$|\.sw[a-p]$|~$/;

/** root 以下の配布物。印のディレクトリへは降りない（走査中に session が終わると消える）。 */
function distributed(root: string, tracked: boolean): Map<string, string> {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (dir === root && HOST_MARKS.has(e.name)) return [];
      const abs = path.join(dir, e.name);
      return e.isDirectory() ? walk(abs) : e.isFile() ? [path.relative(root, abs)] : [];
    });
  // repository は git が追跡しているものと、bundle が作る配布物が配られる。
  // ignore 対象や editor の一時ファイルは差に数えない。
  let rels: string[] | undefined;
  if (tracked) {
    try {
      rels = execFileSync("git", ["-C", root, "ls-files", "-z"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\0")
        .filter((rel) => rel && fs.existsSync(path.join(root, rel)));
      // **生成物は git が追跡しないが、npm の files はこれを配る**（.gitignore の plugin/dist と plugin/db）。
      // 追跡分だけを基準にすると、導入先にあって基準に無いものが全部差になり、正常な導入が壊れて見える。
      rels = [...rels, ...walk(root).filter((rel) => GENERATED.test(rel) && !JUNK.test(path.basename(rel)))];
    } catch {
      // git の外（tarball で取った repository など）は全部を数える。
    }
  }
  rels ??= walk(root);
  return new Map(
    rels.filter((rel) => path.basename(rel) !== ".DS_Store").map((rel) => [rel, path.join(root, rel)]),
  );
}

/**
 * 2 つの root で中身が違うファイル。**mtime は見ない** — 同じ中身の再 bundle で誤検知する。
 * `tracked` は a が repository の作業ツリーのときに立てる。
 */
export function differingFiles(a: string, b: string, { tracked = false } = {}): string[] {
  const x = distributed(a, tracked);
  const y = distributed(b, false);
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

const CACHED = /\/plugins\/cache\/[^/]+\/gleanery\/[^/]+$/;

export type Install = { version: string | null; packageVersion?: string | null; root: string };
export type Running = {
  pid: number;
  started: Date;
  root: string | null;
  version: string | null;
  /** 同じパスに作り直された起動元から、消えた旧ディレクトリの中身で動いている。 */
  replaced?: boolean;
};

export type Seen = {
  /** 作業ツリーの plugin/。cwd か CLI の置き場所が gleanery の repository のときだけ見える。 */
  repository: Install | null;
  cli: Install;
  /**
   * `npm i -g` で入れた CLI。実行中のものとは別に古いまま残りうる（plugin の cache とも更新の操作が違う）。
   * null は入っていないか、npm を叩けなかったとき。
   */
  global: Install | null;
  /** null は導入されていない、"unknown" は claude コマンドが使えず観測できなかった。 */
  claude: Install | null | "unknown";
  codex: Install[];
  codexCache: string;
  /** null は ps が使えず観測できなかった。 */
  running: Running[] | null;
};

/** 外部コマンドを叩く観測をここに集める。判定は report() が行い、テストは Seen を組んで渡す。 */
export function observe(cwdRoot: string): Seen {
  const install = (root: string): Install => ({
    version: versionAt(root),
    packageVersion: packageVersionAt(root),
    root,
  });

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
    ) as { id: string; version?: string; installPath?: string; scope?: string }[];
    // 同じ id が scope ごとに並ぶ。README の導入手順と、下で案内する `claude plugin update`（既定は
    // user scope）に揃えて user の導入だけを見る。project / local は別の場所の session にしか効かない。
    const m = list.find((p) => p.id.startsWith("gleanery@") && p.scope === "user");
    claude = m?.installPath ? { version: m.version ?? null, root: m.installPath } : null;
  } catch {
    claude = "unknown";
  }

  // `codex plugin list --json` は 7 秒かかり、返る version が cache のものか source のものか
  // 区別できない。cache の置き場所を直接読む。
  // lsof は symlink を解いたパスを返すので、実行中の MCP と突き合わせる側も解いておく。
  // cache が丸ごと消えていても解けるよう、CODEX_HOME の側で解く。
  let codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  try {
    codexHome = fs.realpathSync(codexHome);
  } catch {
    // 無ければ下の走査が空になり、「見つからない」と出る。
  }
  const codexCache = path.join(codexHome, "plugins", "cache");
  const codex: Install[] = [];
  for (const market of safeDirs(codexCache)) {
    for (const v of safeDirs(path.join(codexCache, market, "gleanery"))) {
      codex.push(install(path.join(codexCache, market, "gleanery", v)));
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
      // 表示するのは起動時のバージョン。消えた・作り直された cache はディレクトリ名がそれにあたる。作業ツリーは
      // 起動後も書き換わるので、bundle か manifest が起動より新しければ今のバージョンで動いているとは言えない。
      let version = cwd.replaced || now === null ? (cached ? path.basename(root) : null) : now;
      if (!cached && version !== null) {
        try {
          const touched = Math.max(
            ...[path.join("dist", "mcp.js"), MANIFEST].map((f) => fs.statSync(path.join(root, f)).mtimeMs),
          );
          if (touched > p.started.getTime()) version = null;
        } catch {
          version = null;
        }
      }
      return [{ pid: p.pid, started: p.started, root, version, replaced: cwd.replaced }];
    });
  } catch {
    running = null;
  }

  // **plugin の cache とは別経路である。**`claude plugin update` では上がらず、DB の revision が
  // 上がった日に、古い CLI だけが「revision N を期待している」で落ちる。
  let global: Install | null = null;
  try {
    const at = path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "gleanery");
    if (fs.existsSync(at)) global = install(at);
  } catch {
    global = null;
  }

  return { repository, cli: install(ROOT), global, claude, codex, codexCache, running };
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
// 更新後も動いている MCP は旧バージョンのパスのまま。Claude Code は対話端末の session なら
// /reload-plugins で新しいパスへ移る（公式 plugins-reference）。Codex は開き直す。
/** 古い導入の直し方。打つ command と、打った後にすること（after） */
const UPDATE = {
  global: { who: "npm の CLI", command: "npm i -g gleanery@<バージョン>", after: null },
  claude: {
    who: "Claude Code",
    command: "claude plugin marketplace update gleanery && claude plugin update gleanery@gleanery",
    after: "開いている session で /reload-plugins",
  },
  codex: {
    who: "Codex",
    command: "codex plugin marketplace upgrade gleanery && codex plugin add gleanery@gleanery",
    after: "Codex を開き直す",
  },
} as const;

export type Update = { who: string; command: string; after: string | null };

/** 更新の手順の最後に添える注意。届く中身が何で決まるか */
export const UPDATE_NOTE =
  "届く中身は各ホストの marketplace の取得元で決まる。GitHub から取る設定なら、push していない変更は届かない";
const RELOAD = { claude: "/reload-plugins か session の張り直し", codex: "Codex の開き直し" };

/**
 * doctor の plugin 節。**比較の基準は repository**（無ければ各ホストの導入済みバージョン）で、
 * 実行中の CLI は基準にしない。古い session の PATH にある cache の CLI を基準にすると、
 * 新しいほうを「古い」と言う逆転が起きる。
 */
export function report(s: Seen, now = new Date()): { lines: string[]; issues: string[]; updates: Update[] } {
  const lines: string[] = [];
  const issues: string[] = [];
  const todo = new Set<keyof typeof UPDATE>();
  const home = os.homedir();
  const short = (p: string) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const say = (m: Mark, label: string, text: string) => {
    if (m === "warn" || m === "fail") issues.push(label);
    lines.push(`  ${mark(m)} ${pad(label, 19)}${text}`);
  };
  // 理由はパスの後ろに続けず、次の行でパスの列に揃える（パスが長いと、続けた理由が端末の右で折れて読めない）
  const row = (
    label: string,
    i: Install | null,
    note?: string,
    aside = "",
    m: Mark = note ? "warn" : "ok",
  ) => {
    const version = pad(i?.version ?? "不明", 9);
    const indent = " ".repeat(2 + 2 + width(pad(label, 19)) + width(version));
    say(
      m,
      label,
      `${version}${i ? faint(short(i.root)) : ""}${faint(aside)}${note ? `\n${indent}${caution(note)}` : ""}`,
    );
  };
  const packageInstall = (i: Install): Install => ({ version: i.packageVersion ?? null, root: i.root });
  const packageBase = packageInstall(s.repository ?? s.cli);
  const packageAgainst = (i: Install): { note?: string; update?: boolean } => {
    const candidate = packageInstall(i);
    if (!candidate.version || !packageBase.version) return {};
    const c = compareVersions(candidate.version, packageBase.version);
    if (c < 0) return { note: `repositoryのnpm package（${packageBase.version}）より古い`, update: true };
    if (c > 0 && s.repository) {
      return { note: `repositoryのnpm package（${packageBase.version}）より新しい。checkoutが古い` };
    }
    return {};
  };

  lines.push("npm package のバージョン");
  if (s.repository) row("repository", packageInstall(s.repository));
  row("実行中の CLI", packageInstall(s.cli), packageAgainst(s.cli).note);
  if (s.global && path.resolve(s.global.root) !== path.resolve(s.cli.root)) {
    const { note, update } = packageAgainst(s.global);
    if (update) todo.add("global");
    row("npm i -g の CLI", packageInstall(s.global), note);
  }
  lines.push("");
  // **repository が無いほうが普通になる。**npm から入れた利用者は clone を持たないので、
  // そこで比べるのをやめると、CLI と plugin が別々に更新されてずれたことを誰も言わなくなる
  // （CLI は `npm i -g`、plugin は `claude plugin update` で、更新の操作が別々）。
  const base = s.repository ?? (s.cli.version ? s.cli : null);
  const baseName = s.repository ? "repository" : "この CLI";

  /**
   * 基準との食い違いと、ホストの更新で直るか。同じバージョンなら中身まで比べる（バージョンを上げずに変えたものを見落とさない）。
   * 導入側が新しいときと、同じバージョンで中身だけ違うときは、更新しても変わらないので手順を出さない
   * （cache はバージョンが変わったときだけ複製し直される）。
   */
  const against = (i: Install): { note?: string; update?: boolean } => {
    if (!fs.existsSync(i.root)) return { note: "導入先が無い。Skill のパスも無効", update: true };
    if (!base?.version || !i.version) return {};
    const c = compareVersions(i.version, base.version);
    if (c < 0) return { note: `${baseName}（${base.version}）より古い`, update: true };
    if (c > 0) {
      return {
        note: s.repository
          ? `repository（${base.version}）より新しい。repository の checkout が古い`
          : `この CLI（${base.version}）より新しい。\`npm i -g gleanery@${i.version}\` で CLI を揃える`,
      };
    }
    if (path.resolve(i.root) === path.resolve(base.root)) return {};
    // `tracked` は基準が repository の作業ツリーのときだけ立てる。導入先どうしの比較では、
    // 追跡の概念が無く、配られたファイルがそのまま両側にある。
    const diff = differingFiles(base.root, i.root, { tracked: Boolean(s.repository) });
    if (!diff.length) return {};
    const files = `${diff.slice(0, 3).join(", ")}${diff.length > 3 ? " など" : ""}`;
    return {
      note: s.repository
        ? `同じバージョンなのに中身が違う（${files}）。repository の変更は、バージョンを上げて main へ入れるまで届かない`
        : `同じバージョンなのに中身が違う（${files}）。入れ直して揃える`,
    };
  };

  lines.push("plugin channel のバージョン");
  if (s.repository) row("repository", s.repository);
  else say("none", "repository", "見えない。この CLI のバージョンを基準に比べる");

  row("この CLI 内 plugin", s.cli, against(s.cli).note);

  if (s.claude === "unknown") say("none", "Claude Code", "不明（claude plugin list --json が使えない）");
  else if (s.claude === null) say("none", "Claude Code", "導入されていない");
  else {
    const { note, update } = against(s.claude);
    if (update) todo.add("claude");
    row("Claude Code", s.claude, note);
  }

  if (s.codex.length === 0) say("none", "Codex", `見つからない（${short(s.codexCache)} を見た）`);
  for (const x of s.codex) {
    // 入れ直すと Codex は旧バージョンの cache を消す（codex-cli 0.153.4 で観測）。
    const { note, update } =
      s.codex.length > 1
        ? { note: "cache が複数ある。どれを使うかは Codex が決める", update: true }
        : against(x);
    if (update) todo.add("codex");
    row("Codex", x, note);
  }

  // repository が見えないときの最低限: 同じバージョンなのに 2 つのホストで中身が違う。どちらが古いかは断定しない。
  const x = s.codex.length === 1 ? s.codex[0] : undefined;
  if (!base && s.claude && s.claude !== "unknown" && x && s.claude.version === x.version) {
    if (fs.existsSync(s.claude.root) && differingFiles(s.claude.root, x.root).length) {
      say("warn", "Claude Code と Codex", "同じバージョンなのに中身が違う");
    }
  }

  if (s.running === null) say("none", "実行中の MCP", "不明（ps が使えない）");
  else if (s.running.length === 0) say("none", "実行中の MCP", "無い");
  for (const r of s.running ?? []) {
    const when = r.started
      .toLocaleString("sv-SE")
      .slice(r.started.toDateString() === now.toDateString() ? 11 : 5, 16);
    const label = `MCP pid ${r.pid}`;
    const aside = `（${when} 起動）`;
    if (!r.root) {
      row(label, null, "起動元が分からない", aside, "none");
      continue;
    }
    const codex = r.root.startsWith(`${s.codexCache}/`);
    const installed = codex ? (s.codex.length === 1 ? s.codex[0] : undefined) : s.claude;
    const again = RELOAD[codex ? "codex" : "claude"];
    const state = rootState(r.root);
    let note: string | undefined;
    if (state === "gone") note = `起動元が消えている。Skill のパスも無効なので、${again}で直す`;
    else if (r.replaced)
      note = `起動元が同じ場所に作り直され、消えた古いバージョンの中身で動いている。${again}で直す`;
    else if (!CACHED.test(r.root)) {
      note =
        "配布された cache ではなく、この場所を直接読んでいる（directory 型 marketplace か --plugin-dir）";
    } else if (state === "orphaned") note = `Claude Code が更新で置き換えたバージョン。${again}で直す`;
    else if (installed && installed !== "unknown" && installed.version && r.version) {
      if (compareVersions(r.version, installed.version) < 0)
        note = `導入済みの ${installed.version} より古い。${again}で直す`;
    }
    row(label, { version: r.version, root: r.root }, note, aside);
  }

  // npm の CLI は上げる先のバージョンが分かっているので埋める（そのまま打てる形にする）
  const updates = [...todo].map((k): Update => {
    const u = UPDATE[k];
    return k === "global" && packageBase.version
      ? { ...u, command: `npm i -g gleanery@${packageBase.version}` }
      : { ...u };
  });
  return { lines, issues, updates };
}
