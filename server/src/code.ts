// 実物のコードを見に行く。
//
// **コードは埋め込まない。**埋め込むと取り込んだ瞬間から古くなり、直したはずの実装が
// 古い姿で返る。ナレッジ（なぜそうしたか）は変わらないから貯める価値があるが、
// コード（いまどうなっているか）は変わるので、聞かれたときに読みに行くほうが正しい。
//
// 探すのは rg。**自前で走査を書かない** — .gitignore を尊重し、バイナリを飛ばし、
// 巨大なリポジトリでも速いという条件を全部満たしているものが既にある。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 読んでよい場所。**チャットで選ばれた範囲のディレクトリだけ。** */
export type Root = { label: string; dir: string };

/**
 * 相対パスを絶対パスへ直しつつ、根の外へ出ていないかを確かめる。
 *
 * **`..` を弾くだけでは足りない。**symlink を辿った先が根の外ということがあるので、
 * 実体まで解決してから前方一致で見る。ここが唯一の信頼境界で、
 * ここを抜けると任意のファイルが読める。
 */
function inside(root: Root, rel: string): string | null {
  const base = fs.realpathSync(root.dir);
  const full = path.resolve(base, rel);
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    return null;
  }
  return real === base || real.startsWith(`${base}${path.sep}`) ? real : null;
}

// 資格情報は返さない。**探索の結果に混ざるのが一番危ない**（読んだ本人は探していない）。
const SECRET = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*credentials.*\.json|\.netrc)$/i;

/** rg は 1 件も無いと終了コード 1 を返す。見つからないのは失敗ではない。 */
function rg(dir: string, args: string[]): string | null {
  try {
    return execFileSync("rg", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * 上限を掛けずに一致を数える。
 *
 * **返す件数とは別に走らせる。**候補の収集は `--max-count` と limit で切っているので、
 * その結果を数えても総数は出ない。総数が無いと、返った 30 件が全部だと読まれる。
 */
function countMatches(
  roots: Root[],
  q: { query: string; glob?: string },
): {
  files: number;
  lines: number;
} {
  let files = 0;
  let lines = 0;
  for (const root of roots) {
    const args = ["--count", "--max-filesize", "1M", "-i", "-e", q.query];
    if (q.glob) args.push("--glob", q.glob);
    args.push(".");
    const raw = rg(root.dir, args);
    if (!raw) continue;
    for (const row of raw.split("\n")) {
      // rg --count の 1 行は `path:件数`。パスに `:` が入りうるので後ろから割る。
      const i = row.lastIndexOf(":");
      if (i < 0) continue;
      const file = row.slice(0, i).replace(/^\.\//, "");
      const n = Number(row.slice(i + 1));
      if (!file || SECRET.test(file) || !Number.isFinite(n)) continue;
      files += 1;
      lines += n;
    }
  }
  return { files, lines };
}

/** 語で探す。返すのはファイル・行番号・その行だけで、周辺は read_code で読ませる。 */
export function grepCode(
  roots: Root[],
  q: { query: string; repo?: string; glob?: string; limit?: number },
): {
  hits: { repo: string; path: string; line: number; text: string }[];
  /** 上限を掛けずに数えた本文一致の総数。ファイル名だけの一致は含まない。 */
  matched: { files: number; lines: number };
} {
  const want = roots.filter((r) => !q.repo || r.label.includes(q.repo) || r.dir.includes(q.repo));
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit ?? 30)) || 30, 1), 100);
  const out: { repo: string; path: string; line: number; text: string }[] = [];

  // **名前がファイル名にしか無いことがある。**dbt のモデルは `.sql` の中に自分の名前を
  // 書かない（ファイル名がモデル名）ので、中身だけ探すと当たらない（実測で踏んだ）。
  // 同じことが React のコンポーネント、Terraform のモジュール、テストの対象名でも起きる。
  for (const root of want) {
    if (out.length >= limit) break;
    const names = rg(root.dir, ["--files"]);
    if (!names) continue;
    const needle = q.query.toLowerCase();
    for (const f of names.split("\n")) {
      if (out.length >= limit) break;
      const file = f.replace(/^\.\//, "");
      if (!file || SECRET.test(file)) continue;
      if (!file.toLowerCase().includes(needle)) continue;
      out.push({ repo: root.label, path: file, line: 0, text: "（ファイル名が一致）" });
    }
  }

  for (const root of want) {
    if (out.length >= limit) break;
    // **引数として渡す。**シェルを挟まないので、query に何が入っていても語のまま扱われる。
    const args = ["--json", "--max-count", "5", "--max-filesize", "1M", "-i", "-e", q.query];
    if (q.glob) args.push("--glob", q.glob);
    args.push(".");
    const raw = rg(root.dir, args);
    if (!raw) continue;
    for (const line of raw.split("\n")) {
      if (out.length >= limit) break;
      if (!line.startsWith("{")) continue;
      let m: { type?: string; data?: Record<string, unknown> };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type !== "match" || !m.data) continue;
      const file = String((m.data.path as { text?: string })?.text ?? "");
      if (!file || SECRET.test(file)) continue;
      out.push({
        repo: root.label,
        path: file.replace(/^\.\//, ""),
        line: Number(m.data.line_number ?? 0),
        text: String((m.data.lines as { text?: string })?.text ?? "")
          .trim()
          .slice(0, 300),
      });
    }
  }
  return { hits: out, matched: countMatches(want, q) };
}

/** 1 ファイルの一部を読む。**全文は返さない** — 大きいファイルで文脈が埋まる。 */
export function readCode(
  roots: Root[],
  q: { repo: string; path: string; from?: number; lines?: number },
): { repo: string; path: string; from: number; text: string } | { error: string } {
  const root = roots.find((r) => r.label.includes(q.repo) || r.dir.includes(q.repo));
  if (!root) return { error: `${q.repo} は見ている範囲に無い` };
  if (SECRET.test(q.path)) return { error: "資格情報の入りうるファイルは読まない" };
  const full = inside(root, q.path);
  if (!full) return { error: `${q.path} は ${root.label} の外か、存在しない` };
  const st = fs.statSync(full);
  if (!st.isFile()) return { error: `${q.path} はファイルではない` };
  if (st.size > 2 * 1024 * 1024)
    return { error: `${q.path} は大きすぎる（${Math.round(st.size / 1024)}KB）` };

  const all = fs.readFileSync(full, "utf8").split("\n");
  const from = Math.max(1, Math.trunc(Number(q.from ?? 1)) || 1);
  const count = Math.min(Math.max(Math.trunc(Number(q.lines ?? 80)) || 80, 1), 300);
  const slice = all.slice(from - 1, from - 1 + count);
  return {
    repo: root.label,
    path: q.path,
    from,
    text: slice.map((l, i) => `${from + i}\t${l}`).join("\n"),
  };
}
