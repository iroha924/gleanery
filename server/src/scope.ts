// 作業場所の識別と、関連する束の設定。
//
// なぜリポジトリ名を識別子にしないか: git init していないディレクトリで作業することが多い
// （実測: 作業ディレクトリ 7 件中 3 件が git 管理外）。
// なぜ推論で束ねないか: 実測で、関連する 5 件が example-org と another-org の
// 2 つの org にまたがっていた。org でも親ディレクトリでも当たらない。
// 親ディレクトリは特に駄目で、~/Projects に全 9 件が同居していて全部 1 つになる。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export type Ident = {
  ident: string;
  identKind: "git-remote" | "abs-path";
  absPath: string;
  hostOrg: string | null;
  repoName: string;
  label: string;
};

/**
 * git remote を、ホスト差（ssh / https、.git の有無、ポート）を吸収した形へ揃える。
 *
 * **自前で authority を切らない。**`https://user:p@ss@host/o/r` のようにパスワードへ `@` が
 * 入る形は実在し（curl も git も最後の `@` を区切りとする）、「最初の `@` まで」で切ると
 * 資格情報の断片が識別子に残って DB へ平文で入る（実測で再現した）。
 * WHATWG の URL パーサは最後の `@` を区切りとするので、そちらへ寄せる。
 */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  // scp 風（git@host:path）は URL ではないので先に捌く。`://` を伴うものは除く。
  const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?$/);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(raw);
    // hostname はポートも資格情報も含まない。identity にポートは要らない。
    if (!u.hostname) return null;
    const path = u.pathname.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
    return path ? `${u.hostname}/${path}` : u.hostname;
  } catch {
    return null;
  }
}

export function identify(dir: string): Ident {
  const given = path.resolve(dir);
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", given, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      /* git が無い、remote が無い。どちらも普通のこと */
      return null;
    }
  };
  const remote = normalizeRemote(git("remote", "get-url", "origin"));
  // **識別子と置き場所の基点を揃える。**git は親方向へ `.git` を探すので remote は
  // 根まで遡るのに、パスは渡されたディレクトリのままだった。リポジトリの途中で
  // `mitos search` を叩くだけで「この scope の置き場所」がサブディレクトリに書き換わり、
  // 翌朝の同期がそこを根として読んで、根から取った節を全部墓標にする。
  // **remote の有無で分けない。**remote が無い git リポジトリでは識別子が `path:` になるので、
  // 基点がずれるとサブディレクトリごとに別の作業場所ができる。
  const top = git("rev-parse", "--show-toplevel");
  const abs = top || given;
  const rest = remote ? remote.split("/").slice(1) : [];
  return {
    ident: remote ? `git:${remote}` : `path:${abs}`,
    identKind: remote ? "git-remote" : "abs-path",
    absPath: abs,
    hostOrg: rest.length > 1 ? (rest[0] ?? null) : null,
    repoName: rest.length ? (rest[rest.length - 1] ?? "") : path.basename(abs),
    label: remote ? rest.join("/") : path.basename(abs),
  };
}

// 何のプロジェクトかの手がかり。Claude が中を見るときの入口になる。
const MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "dbt_project.yml",
  "Dockerfile",
  "docker-compose.yml",
  "main.tf",
  "Chart.yaml",
  "kustomization.yaml",
  "next.config.js",
  "requirements.txt",
  "README.md",
];

/**
 * 束ねる候補。**~/Projects の直下だけ。**
 * 以前は transcript から実際の作業ディレクトリも拾っていたが、
 * `~/.claude/plugins/...` や `~/Documents/...` まで並んで選びにくかった。
 * git 管理外のディレクトリも ~/Projects の下にあれば拾える。
 */
export function candidates(
  roots: string[] = [path.join(HOME, "Projects")],
): (Ident & { markers: string[] })[] {
  const found = new Set<string>();
  const add = (d: string) => {
    if (!found.has(d) && fs.existsSync(d) && fs.statSync(d).isDirectory()) found.add(d);
  };

  for (const root of roots) {
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of es) if (e.isDirectory() && !e.name.startsWith(".")) add(path.join(root, e.name));
  }
  return [...found].sort().map((d) => ({
    ...identify(d),
    markers: MARKERS.filter((m) => fs.existsSync(path.join(d, m))),
  }));
}

// --- そのホストでの置き場所 ---

import type pg from "pg";

/**
 * どのマシンから見ているか。
 * **識別子（git remote）はマシンをまたいで同じで、変わるのはパスだけ。**
 */
export const HOST = os.hostname();

/**
 * このホストでの置き場所を覚える。**まだ無いときだけ書く。**
 *
 * **黙って差し替えない。**識別子は git の remote なので、同じ remote を持つ空のリポジトリを
 * 置いて `--cwd` でそこを指すだけで、日次同期の対象と `read_code` の根を丸ごと移せてしまう。
 * 置き場所を変えるのは `mitos adopt`（`replace`）だけにして、そこは食い違いを見せて止める。
 *
 * 変えなかったときは false を返す。
 */
export async function rememberPath(
  client: pg.Client,
  scopeId: number,
  absPath: string,
  { replace = false } = {},
): Promise<boolean> {
  const r = await client.query(
    replace
      ? `insert into scope_path (scope_id, host, abs_path) values ($1,$2,$3)
         on conflict (scope_id, host) do update set abs_path = excluded.abs_path, seen_at = now()`
      : `insert into scope_path (scope_id, host, abs_path) values ($1,$2,$3)
         on conflict (scope_id, host) do update set seen_at = now()
         where scope_path.abs_path = excluded.abs_path`,
    [scopeId, HOST, absPath],
  );
  return (r.rowCount ?? 0) > 0;
}
