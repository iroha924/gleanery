// 作業場所（project）の識別。
//
// key は git remote を正規化したもの（`git:github.com/owner/repo`）で、PC をまたいで同じになる。
// remote の無い作業場所だけ、PC ごとの対応表（~/.claude/mitos-projects.json）で `local:<名前>` に結ぶ。
// ローカルのパスは DB に置かない。置き場所は PC ごとに違い、同期は各 PC で ~/Projects を見て探す。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "./db.ts";

export type Place = { key: string; root: string; name: string };

// 置き場所は呼び出しのたびに決める（HOME を差し替えたテストが本物の対応表を触らない）。
const localFile = (): string => path.join(os.homedir(), ".claude", "mitos-projects.json");
const LOCAL_KEY = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * git remote を、ssh / https、.git の有無、ポート、資格情報の差を吸収した形へ揃える。
 * authority は URL パーサに切らせる。パスワードに `@` が入る形で自前に切ると、資格情報の断片が key に残る。
 */
export function normalizeRemote(url: string | null | undefined): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  // scp 風（git@host:path）は URL ではないので先に捌く。
  const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?$/);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    const p = u.pathname.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
    return p ? `${u.hostname}/${p}` : u.hostname;
  } catch {
    return null;
  }
}

const git = (dir: string, ...args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
};

function localMap(): Record<string, string> {
  try {
    const m = JSON.parse(fs.readFileSync(localFile(), "utf8")) as unknown;
    return m && typeof m === "object" ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** リポジトリの根。git の外なら dir そのもの。 */
export const rootOf = (dir: string): string =>
  git(path.resolve(dir), "rev-parse", "--show-toplevel") || path.resolve(dir);

/**
 * dir が属する作業場所。どちらでもなければ null（記録も同期もしない）。
 * **根はリポジトリの top-level にする。**サブディレクトリから呼ばれても、相対パスの基点がずれない。
 */
export function identify(dir: string): Place | null {
  const given = path.resolve(dir);
  const top = git(given, "rev-parse", "--show-toplevel");
  const root = top || given;
  const remote = top ? normalizeRemote(git(root, "remote", "get-url", "origin")) : null;
  if (remote) return { key: `git:${remote}`, root, name: remote.split("/").slice(1).join("/") || remote };
  // git 管理外の作業場所は、サブディレクトリで作業していても名前を付けた根まで遡って引く。
  const map = localMap();
  for (let d = root; ; d = path.dirname(d)) {
    const local = map[d];
    if (local && LOCAL_KEY.test(local)) return { key: `local:${local}`, root: d, name: local };
    if (top || path.dirname(d) === d) return null;
  }
}

/** remote の無い作業場所に、この PC で名前を付ける。 */
export function nameLocal(dir: string, name: string): Place {
  if (!LOCAL_KEY.test(name)) throw new Error(`名前は小文字英数字と . _ - だけにする: ${name}`);
  const root = rootOf(dir);
  const m = localMap();
  m[root] = name;
  fs.writeFileSync(localFile(), `${JSON.stringify(m, null, 2)}\n`);
  return { key: `local:${name}`, root, name };
}

/** その作業場所の project id。無ければ null（作るのは `mitos project add` だけ）。 */
export async function projectId(db: Db, key: string): Promise<number | null> {
  const r = await db.query<{ id: string }>("select id from mitos.project where key = $1", [key]);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

/**
 * この PC で、登録済みの作業場所の置き場所を探す。~/Projects の直下と、名前を付けた作業場所だけを見る。
 * **同じ key の置き場所が 2 つあれば選ばない。**並び順で先に来た複製へ黙って同期しない。
 */
export function localRoots(roots = [path.join(os.homedir(), "Projects")]): {
  found: Map<string, string>;
  ambiguous: Map<string, string[]>;
} {
  const seen = new Map<string, string[]>();
  const add = (p: Place | null) => {
    if (p) seen.set(p.key, [...new Set([...(seen.get(p.key) ?? []), p.root])]);
  };
  for (const r of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith(".")) add(identify(path.join(r, e.name)));
  }
  for (const [root, name] of Object.entries(localMap())) {
    if (LOCAL_KEY.test(name) && fs.existsSync(root)) add({ key: `local:${name}`, root, name });
  }
  const found = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const [key, dirs] of seen) {
    if (dirs.length === 1 && dirs[0]) found.set(key, dirs[0]);
    else ambiguous.set(key, dirs);
  }
  return { found, ambiguous };
}

/** 作業場所の根からの相対パス。根の外、または読めない形なら null。 */
export function relativeTo(root: string, file: string, cwd = root): string | null {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** 取り込み元の行。無ければ作る。同期の成否はここへ書く（`mitos doctor` と画面が最後の同期を出す）。 */
export async function connectorOf(db: Db, projectId: number, provider: "github" | "docs"): Promise<string> {
  await db.query(
    "insert into mitos.connector (project_id, provider) values ($1, $2) on conflict (project_id, provider) do nothing",
    [projectId, provider],
  );
  const r = await db.query<{ id: string }>(
    "select id from mitos.connector where project_id = $1 and provider = $2",
    [projectId, provider],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`取り込み元を作れなかった: ${provider}`);
  return id;
}

/** Codex の apply_patch は編集先を patch の見出しに書く。見出しの 4 形だけを読む（本文は読まない）。 */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}
