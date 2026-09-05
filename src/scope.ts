// 作業場所の識別と、関連する束の設定。
//
// なぜリポジトリ名を識別子にしないか: git init していないディレクトリで作業することが多い
// （実測: 作業ディレクトリ 7 件中 3 件が git 管理外）。
// なぜ推論で束ねないか: 実測で、関連する 5 件が macbee-planet と netmarketing の
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

/** git remote を、ホスト差（ssh / https、.git の有無）を吸収した形へ揃える。
 *  資格情報付きの URL が来ることがあるので、user:pass@ は落とす。 */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url)
    .trim()
    .match(/(?:git@|https?:\/\/)(?:[^@/]*@)?([^:/]+)[:/](.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function identify(dir: string): Ident {
  const abs = path.resolve(dir);
  let remote: string | null = null;
  try {
    remote = normalizeRemote(
      execFileSync("git", ["-C", abs, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    /* git が無い、remote が無い。どちらも普通のこと */
  }
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

/** 候補を並べる。~/Projects 配下と、transcript に現れた作業ディレクトリの和。 */
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
  // 実際に作業した場所。~/Projects の外や git 管理外もここで拾う。
  for (const f of transcriptCwds()) add(f);

  return [...found].sort().map((d) => ({
    ...identify(d),
    markers: MARKERS.filter((m) => fs.existsSync(path.join(d, m))),
  }));
}

function transcriptCwds(): Set<string> {
  const out = new Set<string>();
  const roots = [path.join(HOME, ".claude", "projects"), path.join(HOME, ".codex", "sessions")];
  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "subagents") walk(p, depth + 1);
        continue;
      }
      if (!e.name.endsWith(".jsonl")) continue;
      // 先頭の数行だけ見る。cwd は最初の方に必ず出る。
      let head = "";
      try {
        head = fs.readFileSync(p, "utf8").slice(0, 40000);
      } catch {
        continue;
      }
      for (const line of head.split("\n").slice(0, 20)) {
        try {
          const o = JSON.parse(line) as { cwd?: string; payload?: { cwd?: string } };
          const cwd = o.cwd ?? o.payload?.cwd;
          if (cwd) {
            out.add(cwd);
            break;
          }
        } catch {
          /* 途中で切れた行は飛ばす */
        }
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}
