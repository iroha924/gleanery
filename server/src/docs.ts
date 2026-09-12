// リポジトリの Markdown をナレッジにする。
//
// **コードは埋め込まないが、文書は埋め込む。**code.ts が「コード（いまどうなっているか）は
// 変わるので、聞かれたときに読みに行く」と決めているのに対し、設計文書と ADR は
// 「なぜそうしたか」であり、そこで貯める価値があると同じ判断が名指ししている。
// そしてリポジトリが消えれば読みに行く先も消える。
//
// **見出しで切る。**ファイル 1 本を丸ごと 1 件にすると、3,460 行の設計書が
// 1 つのベクトルに潰れて何にも当たらない。節は書いた人が付けた意味の区切りなので、
// 機械が長さで切るより境界が正しい。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { type Artifact, selectArtifacts, underMitos } from "./artifacts.ts";
import { EMBED_MODEL, type Env, embed, vec } from "./db.ts";

export type Section = {
  key: string;
  /** リポジトリ根からの相対パス */
  path: string;
  /** この節の見出し（先頭の節だけはファイル名） */
  title: string;
  /** 祖先の見出しをつないだ道。埋め込みの前置きに使う */
  trail: string;
  text: string;
  /** その文書を最後に触ったコミットの日時。未コミットなら null */
  at: string | null;
  ordinal: number;
  /** 承認済みの要件定義・設計書の節なら、その種別と change */
  artifact?: Artifact | undefined;
};

/**
 * 承認済みの成果物の原文。**節を連結しても元の Markdown に戻らない**（見出しだけの節を落とす）ので、
 * ダッシュボードで読ませる本文を別に 1 件持つ。検索しないので埋め込みも持たない。
 */
export type Source = { key: string; path: string; text: string; at: string | null; artifact: Artifact };

/**
 * 1 つの節の上限。**超えたぶんは捨てずに続きの節へ回す。**
 * リポジトリが消えた後は原文を取り直せないので、切り落とすと永久に失われる。
 */
const MAX = 4000;

/** 1 ファイルの上限。これを超える .md は文書ではない（生成物かデータの取り違え）。 */
const MAX_FILE = 2 * 1024 * 1024;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[`*_[\]()#]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "本文";

/**
 * 見出しで節に割る。
 *
 * **コードフェンスの中は見ない。**シェルのコメント（`# 使い方`）や YAML の
 * フロントマターの区切りが見出しに化けて、節が本文の途中で割れる。
 */
export function sections(rel: string, body: string): Section[] {
  // **CRLF と BOM を先に落とす。**JS の `.` は `\r` を行終端として扱うので、
  // `/^(#{1,3}) +(\S.*)$/` が CRLF の見出しに一致しない。Windows で書かれた文書だけが
  // **1 本まるごと 1 つのベクトルに潰れる**（実測）。BOM は先頭の見出しだけを落とす。
  const lines = body
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
  const out: Section[] = [];
  // 見出しの深さごとの直近の題。前置きに使う道を作る
  const trail: string[] = [];
  let fence: string | null = null;
  let cur: { title: string; level: number; trail: string; buf: string[] } = {
    title: path.basename(rel),
    level: 0,
    trail: rel,
    buf: [],
  };
  const used = new Map<string, number>();

  const flush = (): void => {
    const raw = cur.buf.join("\n").trim();
    if (!raw) return;
    // **見出しだけの節は置かない。**「## 背景」の直後に「### 経緯」が来る形で、
    // 中身は子が持っている。実測（nomophyl の 91 本）で 811 件中 64 件がこれで、
    // 埋め込んでも 10 字のベクトルが増えるだけになる。見出し自体は子の trail に残る。
    if (cur.level > 0 && raw === cur.buf.find((l) => l.trim())?.trim()) return;
    // 上限で割る。**段落の切れ目で割る** — 文の途中で切ると両側とも読めなくなる。
    const parts: string[] = [];
    let rest = raw;
    while (rest.length > MAX) {
      const cut = rest.lastIndexOf("\n\n", MAX);
      const at = cut > MAX / 2 ? cut : MAX;
      parts.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    parts.push(rest);
    for (const text of parts) {
      const base = `${rel}#${slug(cur.title)}`;
      // 同じ題の節が 1 つのファイルに何度も出る（「## 背景」など）。
      // key が衝突すると unique (record_id, kind, key) で後勝ちになり、前の節が消える。
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      out.push({
        key: n === 1 && parts.length === 1 ? base : `${base}:${n}`,
        path: rel,
        title: cur.title,
        trail: cur.trail,
        text,
        at: null,
        ordinal: out.length,
      });
    }
  };

  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f?.[1]) {
      if (fence === null) fence = f[1][0] ?? "`";
      else if (line.trimStart().startsWith(fence)) fence = null;
      cur.buf.push(line);
      continue;
    }
    // **`.*\S` にしない。**` +` と取り合って行長の二乗になり、空白 80,000 の 1 行で
    // 2.4 秒かかる（実測。`\S.*` なら 0.14 ms）。日次同期は無人で走るので、
    // 追跡された巨大な .md 1 本で朝の取り込みが止まる。
    const h = fence === null ? line.match(/^(#{1,3}) +(\S.*)$/) : null;
    if (!h?.[1] || !h[2]) {
      cur.buf.push(line);
      continue;
    }
    flush();
    const level = h[1].length;
    const title = h[2].trim();
    trail.length = level - 1;
    trail[level - 1] = title;
    cur = { title, level, trail: [rel, ...trail.filter(Boolean)].join(" > "), buf: [line] };
  }
  flush();
  return out;
}

/**
 * 文書ごとの最終更新日。
 *
 * **文書にも観測時点が要る。**「いつ書かれたか」が無い決定は、10 年前のものでも
 * 恒久的な事実として読まれる。記録の側は全エントリに ISO 8601 を強制しているのに、
 * 取り込んだ文書だけが時点を持たないのは同じ穴になる。
 *
 * **1 回の git log で全部取る。**ファイルごとに叩くと本数に比例して遅くなる。
 */
function lastTouched(dir: string): Map<string, string> {
  const at = new Map<string, string>();
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["-C", dir, "-c", "core.quotepath=false", "log", "--format=@%aI", "--name-only", "--", "*.md", "*.mdx"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // まだ 1 度もコミットしていないリポジトリ。日付なしで進む。
    return at;
  }
  let cur = "";
  for (const line of out.split("\n")) {
    // **日付の形まで見る。**`@` で始まるパス（`@scope/doc.md` など）を日付と読むと、
    // そのファイルが日付を失ううえ、**次のファイルがパス文字列を日付として受け取る**。
    // それは timestamptz へ渡って insert が落ち、そのリポジトリの取り込みが
    // 毎回まるごとロールバックする（実測: `invalid input syntax for type timestamp`）。
    if (/^@\d{4}-\d{2}-\d{2}T/.test(line)) cur = line.slice(1);
    // log は新しい順なので、最初に出たものがその文書の最終更新。
    else if (line && cur && !at.has(line)) at.set(line, cur);
  }
  return at;
}

/**
 * その作業場所で git が追っている Markdown。
 * **自前で走査しない** — gitignore と node_modules を勝手に避ける。
 *
 * **symlink は返さない。**git は追跡された symlink をそのまま列挙し、読む側は
 * その先を開く。`docs/setup.md -> ~/.claude/knowledge.env` を追跡しているリポジトリが
 * 1 つあれば、日次同期が無人で資格情報を埋め込み API へ送り、本文として保存し、
 * 以後どのエージェントの文脈にも返す。**.gitignore は効かない** —
 * ignore されるのは参照先であって、追跡されている symlink 自体ではない。
 */
export function markdownFiles(dir: string): { files: string[]; symlinks: number } {
  const out = execFileSync("git", ["-C", dir, "ls-files", "-z", "*.md", "*.mdx"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // **外へ出さないのは realpath の前方一致。**末端の lstat だけでは足りない —
  // `docs/` 自体が外への symlink だと、`docs/notes.md` の末端は普通のファイルに見える（実測）。
  // 判定は `server/src/code.ts` の `inside()` と同じ形にする。
  // lstat のほうは**リポジトリ内を指す別名**を落とす（同じ本文が 2 つの key で入るのを防ぐ）。
  const base = fs.realpathSync(dir);
  const files: string[] = [];
  let symlinks = 0;
  for (const rel of out.split("\0").filter(Boolean)) {
    let real: string;
    let st: fs.Stats;
    try {
      const full = path.join(dir, rel);
      st = fs.lstatSync(full);
      real = fs.realpathSync(full);
    } catch {
      // git は追っているが手元に無い（sparse checkout、消したまま未コミット）。
      continue;
    }
    if (st.isSymbolicLink() || !(real === base || real.startsWith(`${base}${path.sep}`))) {
      symlinks++;
      continue;
    }
    // **丸ごとメモリへ載せるので上限を置く。**文書として書かれた Markdown が
    // これを超えることはない。超えるのは生成物か、取り違えたデータファイル。
    if (st.size > MAX_FILE) continue;
    files.push(rel);
  }
  return { files, symlinks };
}

/** 埋め込む文。**どの文書のどの節かを前置する**（github.ts の PR 題と同じ発想）。 */
export const sectionText = (s: Section): string => `${s.trail}\n${s.text}`;

const hash = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** ADR は決定そのもの。仕様と分けて引けるようにする。 */
const subkindOf = (rel: string): string =>
  /(^|\/)adr(s)?\//i.test(rel) || /(^|\/)\d{4}-[^/]+\.mdx?$/.test(rel) ? "adr" : "doc";

const CHUNK = 200;

/**
 * 読んだ本文を node の形へ投影する。**`.mitos` 配下は承認済みの成果物だけを入れ**、成果物には検索用の節に加えて
 * 原文を 1 件置く。原文の key は path そのもの — 節の key は必ず `#` を含み、成果物の path は含まないので交わらない
 * （`#@...` のような接尾辞は、見出し slug が `@` を除かないので `## @...` の節と衝突する）。
 */
export function projectDocs(
  bodies: Map<string, string>,
  include: Map<string, Artifact>,
  at: Map<string, string>,
): { sections: Section[]; sources: Source[] } {
  const all: Section[] = [];
  const sources: Source[] = [];
  for (const [rel, body] of bodies) {
    const artifact = include.get(rel);
    if (underMitos(rel) && !artifact) continue;
    for (const s of sections(rel, body))
      all.push({ ...s, at: at.get(rel) ?? null, ordinal: all.length, artifact });
    if (artifact) sources.push({ key: rel, path: rel, text: body, at: at.get(rel) ?? null, artifact });
  }
  return { sections: all, sources };
}

/** リポジトリ 1 つぶん。**docs は 1 記録**にして、どの文書かは node の key が持つ。 */
export async function ingestDocs(
  client: pg.Client,
  env: Env,
  ident: string,
  label: string,
  dir: string,
  scopeId: number,
  onProgress?: (m: string) => void,
): Promise<string> {
  const recordId = `docs:${ident}`;
  const { files, symlinks } = markdownFiles(dir);
  const at = lastTouched(dir);
  const bodies = new Map<string, string>();
  for (const rel of files) {
    try {
      bodies.set(rel, fs.readFileSync(path.join(dir, rel), "utf8"));
    } catch {
      // 読めるとしたものが読めなかった。列挙と読み取りの間に消えた場合。
    }
  }
  // **本文を読み終えてから manifest を読む。**再編集は draft を書いてから本文を触るので、この順なら
  // 編集中の本文は必ず draft として外れる。**不正なら埋め込みと DB 書き込みの前に止める** —
  // どれが承認済みかを決められないまま、前回の状態を壊さない。
  const { include, problems } = selectArtifacts(dir, [...bodies.keys()]);
  if (problems.length) {
    throw new Error(
      `${label} の .mitos が不正なので、このリポジトリの文書を同期しない（前回の状態を保つ）:\n` +
        problems.map((p) => `  ${p.path}: ${p.reason}`).join("\n"),
    );
  }
  const { sections: all, sources } = projectDocs(bodies, include, at);
  const skipped = symlinks ? ` / symlink を飛ばした ${symlinks} 件` : "";

  // **墓標の行も読む。**draft へ戻してから再び承認した節は、本文が同じなら埋め込みを取り直さない。
  const existing = new Map(
    (
      await client.query<{ key: string; content_hash: string; has_emb: boolean }>(
        "select key, content_hash, embedding is not null as has_emb from node where record_id=$1",
        [recordId],
      )
    ).rows.map((r) => [r.key, r]),
  );
  // 原文は `all` に入っていないので、ここで埋め込み対象にならない。
  const need = all.filter((s) => {
    const old = existing.get(s.key);
    return !old || old.content_hash !== hash(sectionText(s)) || !old.has_emb;
  });
  onProgress?.(
    `文書 ${bodies.size} 本 / 節 ${all.length} 件 / 承認済みの成果物 ${sources.length} 本 / 埋め込みを取り直す ${need.length} 件`,
  );

  const byKey = new Map<string, number[] | undefined>();
  for (let from = 0; from < need.length; from += CHUNK) {
    const slice = need.slice(from, from + CHUNK);
    const vectors = await embed(env, slice.map(sectionText), "document");
    for (const [i, s] of slice.entries()) byKey.set(s.key, vectors[i]);
    onProgress?.(`  ${Math.min(from + CHUNK, need.length)} / ${need.length} 件を埋め込み`);
  }

  const put = (n: {
    subkind: string;
    key: string;
    ordinal: number;
    at: string | null;
    text: string;
    attrs: Record<string, unknown>;
    contentHash: string;
    searchable: boolean;
    embedText: string | null;
    vector: number[] | undefined;
  }) =>
    client.query(
      `insert into node (record_id, scope_id, kind, subkind, key, ordinal, at, text, polarity, attrs,
                         actor_kind, content_hash, searchable, embed_text, embed_model, embedded_at, embedding)
       values ($1,$2,'doc',$3,$4,$5,$6,$7,'na',$8,'unknown',$9,$10,$11,$12,$13,$14)
       on conflict (record_id, kind, key) do update set
         subkind=excluded.subkind, ordinal=excluded.ordinal, at=excluded.at, text=excluded.text, attrs=excluded.attrs,
         content_hash=excluded.content_hash, searchable=excluded.searchable, deleted_at=null,
         embed_text=coalesce(excluded.embed_text, node.embed_text),
         embed_model=coalesce(excluded.embed_model, node.embed_model),
         embedded_at=coalesce(excluded.embedded_at, node.embedded_at),
         embedding=coalesce(excluded.embedding, node.embedding)`,
      [
        recordId,
        scopeId,
        n.subkind,
        n.key,
        n.ordinal,
        n.at,
        n.text,
        JSON.stringify(n.attrs),
        n.contentHash,
        n.searchable,
        n.embedText,
        n.vector ? EMBED_MODEL : null,
        n.vector ? new Date().toISOString() : null,
        vec(n.vector),
      ],
    );

  await client.query("begin");
  try {
    // **0 件でも早く返さない。**文書を全部消したとき（README を廃止して DB へ移した等）に
    // 戻ると墓標を立てる処理へ到達せず、撤回した記述が永久に検索で返る。
    // **record も transaction の中で書く。**外で書くと、埋め込みや取り込みが失敗しても ingested_at だけが進み、
    // それを同期時点として出す画面が、入っていない本文を同期済みと表示する。
    await client.query(
      `insert into record (id, scope_id, schema_ver, title, status, problem, goal, created_at, updated_at, raw, raw_hash)
       values ($1,$2,'docs/1',$3,'in-progress','','',now(),now(),'{}'::jsonb,'')
       on conflict (id) do update set updated_at = now(), ingested_at = now()`,
      [recordId, scopeId, `${label} の文書`],
    );
    for (const s of all) {
      const v = byKey.get(s.key);
      await put({
        subkind: subkindOf(s.path),
        key: s.key,
        ordinal: s.ordinal,
        at: s.at,
        text: s.text,
        attrs: {
          path: s.path,
          title: s.title,
          trail: s.trail,
          ...(s.artifact ? { artifact: s.artifact } : {}),
        },
        contentHash: hash(sectionText(s)),
        searchable: true,
        embedText: v ? sectionText(s) : null,
        vector: v,
      });
    }
    for (const s of sources) {
      await put({
        subkind: "artifact-source",
        key: s.key,
        ordinal: 0,
        at: s.at,
        text: s.text,
        attrs: { path: s.path, title: path.basename(s.path), trail: s.path, artifact: s.artifact },
        contentHash: hash(s.text),
        searchable: false,
        embedText: null,
        vector: undefined,
      });
    }
    // **消えた節を残さない。**文書は上書きで編集されるので、節を消して書き直すと
    // 古い本文が DB に残り続け、撤回した記述が検索で返る。PR や会話は追記しか
    // されないのでこの手当てが要らなかったが、文書には要る。承認を外した成果物もここで消える。
    const gone = await client.query<{ n: string }>(
      `update node set deleted_at = now()
       where record_id = $1 and kind = 'doc' and deleted_at is null and not (key = any($2))
       returning 1 as n`,
      [recordId, [...all.map((s) => s.key), ...sources.map((s) => s.key)]],
    );
    await client.query("commit");
    return `${label} / 文書 ${bodies.size} 本・節 ${all.length} 件（埋め込み ${need.length} 件${
      sources.length ? ` / 承認済みの成果物 ${sources.length} 本` : ""
    }${gone.rowCount ? ` / 消えた節 ${gone.rowCount} 件` : ""}）${skipped}`;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
