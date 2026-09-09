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

// 生成物は source と同じ実装を二度見せる。**呼び出し先の glob より先に置く** — rg の glob は
// 後勝ちなので、`plugin/dist/*` を明示した呼び出しはこの除外を上書きできる。
const GENERATED = ["!**/dist/**", "!**/build/**", "!**/*.min.js", "!**/*.bundle.js"];
const globs = (extra?: string): string[] =>
  [...GENERATED, ...(extra ? [extra] : [])].flatMap((g) => ["--glob", g]);

/** 探せなかった場所と、その理由。**作業場所の札 → 理由。** */
type Failures = Map<string, string>;

/**
 * rg を 1 回走らせる。
 *
 * **1 件も無い（終了コード 1）と、探せなかったを分ける。**まとめて null にすると、
 * rg の入っていないホストで「探したが無い」と同じ答えになり、無言で嘘をつく。
 *
 * **見つかった分は返し、失敗は `failed` へ出す。**読めないパスが 1 つあるだけで rg は 2 を返すので、
 * 失敗にすると他で見つかったものまで捨てる。黙って返すと欠けた結果が全部として読まれる。
 */
function rg(root: Root, args: string[], failed: Failures): string | null {
  try {
    return execFileSync("rg", args, {
      cwd: root.dir,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const r = e as { status?: number; code?: string; stdout?: string; stderr?: string };
    if (r.status === 1) return null;
    // **ENOENT を「rg が無い」と断定しない。**根のディレクトリが消えたときも同じ code になる。
    failed.set(
      root.label,
      r.code === "ENOENT"
        ? `rg を起動できない（rg が入っていないか ${root.dir} が無い）`
        : `rg が終了コード ${r.status}: ${(r.stderr ?? "").trim().replace(/\s+/g, " ").slice(0, 200)}`,
    );
    return r.stdout || null;
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
  failed: Failures,
): {
  files: number;
  lines: number;
  paths: string[];
} {
  let files = 0;
  let lines = 0;
  const paths: string[] = [];
  for (const root of roots) {
    const args = ["--count", "--max-filesize", "1M", "-i", "-e", q.query, ...globs(q.glob)];
    args.push(".");
    const raw = rg(root, args, failed);
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
      // 「どのファイル？」には行を全部返せなくても答えられる（実測: 141 行 / 31 ファイル）。
      // 上限は付ける。当たらない語で数千ファイル並ぶと、それ自体が文脈を埋める。
      if (paths.length < 200) paths.push(`${root.label}/${file}`);
    }
  }
  return { files, lines, paths };
}

/** 語で探す。返すのはファイル・行番号・その行だけで、周辺は read_code で読ませる。 */
export function grepCode(
  roots: Root[],
  q: { query: string; repo?: string; glob?: string; limit?: number },
):
  | {
      hits: { repo: string; path: string; line: number; text: string }[];
      /**
       * 名前が一致したファイル。**本文一致とは別の枠にする。**
       * 同じ枠に入れると、名前だけ一致したファイルが limit を食い潰し、
       * 実装を持つファイルが返らないことがある（実測: limit 2 で本文一致 0 件）。
       */
      names: string[];
      /** 上限を掛けずに数えた本文一致の総数と、その全ファイル。ファイル名だけの一致は含まない。 */
      matched: { files: number; lines: number; paths: string[] };
      /** 探せなかった作業場所。**空でないなら、返っている結果は全部ではない。** */
      unsearched: string[];
    }
  | {
      // **探せなかったことを、0 件と同じ形で返さない。**同じにすると
      // 「その語はコードに無い」と答えることになり、探せていないことが誰にも見えない。
      error: string;
    } {
  const want = roots.filter((r) => !q.repo || r.label.includes(q.repo) || r.dir.includes(q.repo));
  // **1 つも当たらないなら探していない。**0 件で返すと「コードに無い」と読まれる（readCode と同じ形）。
  if (want.length === 0) return { error: `${q.repo ?? "見ている範囲"} に当たるリポジトリが無い` };
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit ?? 30)) || 30, 1), 100);
  const failed: Failures = new Map();
  const out: { repo: string; path: string; line: number; text: string }[] = [];

  // **名前がファイル名にしか無いことがある。**dbt のモデルは `.sql` の中に自分の名前を
  // 書かない（ファイル名がモデル名）ので、中身だけ探すと当たらない（実測で踏んだ）。
  // 同じことが React のコンポーネント、Terraform のモジュール、テストの対象名でも起きる。
  const names: string[] = [];
  for (const root of want) {
    const listed = rg(root, ["--files", ...globs(q.glob)], failed);
    if (!listed) continue;
    const needle = q.query.toLowerCase();
    for (const f of listed.split("\n")) {
      if (names.length >= 200) break;
      const file = f.replace(/^\.\//, "");
      if (!file || SECRET.test(file)) continue;
      if (!file.toLowerCase().includes(needle)) continue;
      names.push(`${root.label}/${file}`);
    }
  }

  for (const root of want) {
    if (out.length >= limit) break;
    // **引数として渡す。**シェルを挟まないので、query に何が入っていても語のまま扱われる。
    const args = ["--json", "--max-count", "5", "--max-filesize", "1M", "-i", "-e", q.query];
    args.push(...globs(q.glob), ".");
    const raw = rg(root, args, failed);
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
  const matched = countMatches(want, q, failed);
  const unsearched = [...failed].map(([label, why]) => `${label}: ${why}`);
  // **1 件も見つからず、どこかで失敗しているなら「無い」とは言えない。**
  if (unsearched.length > 0 && out.length === 0 && names.length === 0 && matched.lines === 0)
    return { error: `コードを探せなかった: ${unsearched.join(" / ")}` };
  return { hits: out, names, matched, unsearched };
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
