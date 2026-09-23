// リポジトリの Markdown を、原文（source_item）と検索用の節（knowledge の document）にする。
//
// **コードは入れないが、文書は入れる。**設計文書と ADR は「なぜそうしたか」で、リポジトリが消えれば読む先も消える。
// **見出しで切る。**1 本を丸ごと 1 件にすると、長い設計書の語が 1 件に混ざり、どの節の話かが分からなくなる。
// **原文は別に持つ。**節は見出しだけの節を落とすので、連結しても元の Markdown に戻らない。画面は原文を出す。
//
// **正は remote の既定 branch の commit で、作業ツリーは読まない。**作業ツリーを読むと、どの PC の・どの branch の・
// 書きかけの状態が DB に入るかが同期した順で決まる（branch の切り替え、未 push の commit、古い clone で巻き戻る）。
// 一覧・本文・manifest・更新日を 1 つの commit の tree から読むので、読む順も filesystem の symlink も関係しない。

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Kysely } from "kysely";
import { inTransaction, iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { connectorOf } from "./project.ts";
import { clean, sha256 } from "./text.ts";

export type Section = {
  /** プロジェクトの中で一意な key。`doc:<path>#<見出し>` */
  key: string;
  path: string;
  title: string;
  /** 祖先の見出しをつないだ道。検索の見出しになる */
  trail: string;
  text: string;
};

/** 1 つの節の上限。**超えたぶんは捨てずに続きの節へ回す。**リポジトリが消えた後は取り直せない。 */
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
 * 見出しで節に割る。**コードフェンスの中は見ない。**シェルのコメントや frontmatter の区切りが見出しに化ける。
 * フェンスは開いたときと同じ文字で、同じ長さ以上の、info の無い行でだけ閉じる（CommonMark）。
 * 4 つのバッククォートで囲んだ例の中の 3 つのバッククォートで閉じたと読むと、例の中の見出しが節になる。
 */
export function sections(rel: string, body: string): Section[] {
  // JS の `.` は `\r` を行終端として扱うので、CRLF の見出しが一致しない。BOM は先頭の見出しを落とす。
  const lines = body
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
  const out: Section[] = [];
  const trail: string[] = [];
  let fence: string | null = null;
  let cur: { title: string; level: number; trail: string; buf: string[] } = {
    title: path.basename(rel),
    level: 0,
    trail: rel,
    buf: [],
  };
  const used = new Map<string, number>();
  const keys = new Set<string>();

  const flush = (): void => {
    const raw = cur.buf.join("\n").trim();
    if (!raw) return;
    // 見出しだけの節は置かない。中身は子が持ち、見出しは子の trail に残る。
    if (cur.level > 0 && raw === cur.buf.find((l) => l.trim())?.trim()) return;
    // 上限で割る。段落の切れ目で割る — 文の途中で切ると両側とも読めなくなる。
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
      const base = `doc:${rel}#${slug(cur.title)}`;
      // 同じ題の節は 1 つのファイルに何度も出る（「## 背景」など）。番号で分けないと後勝ちで前の節が消える。
      // 番号を付けた key が別の見出し（「## 背景:2」）と重ならないよう、使った key 全体で一意にする。
      let n = (used.get(base) ?? 0) + 1;
      let key = n === 1 && parts.length === 1 ? base : `${base}:${n}`;
      while (keys.has(key)) key = `${base}:${++n}`;
      used.set(base, n);
      keys.add(key);
      out.push({
        key,
        path: rel,
        title: cur.title,
        trail: cur.trail,
        text,
      });
    }
  };

  for (const line of lines) {
    const f = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (f?.[1]) {
      const mark = f[1];
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && !f[2]?.trim()) fence = null;
      cur.buf.push(line);
      continue;
    }
    // `.*\S` にしない。` +` と取り合って行長の二乗になり、空白 80,000 の 1 行で数秒止まる。
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

// 無人の同期（launchd）で資格情報の入力を待って止まらない。
const git = (root: string, args: string[], input?: Buffer): Buffer =>
  execFileSync("git", ["-C", root, ...args], {
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

/**
 * 同期する commit。remote を持つプロジェクトは、remote の HEAD（既定 branch）をその場で取る。**ローカルの
 * origin/HEAD は読まない** — fetch だけでは既定 branch の名前変更に追随しない。取れなければ投げる（前回の状態を保つ）。
 * 取った先は専用の ref に置く（共有の FETCH_HEAD は同じ PC の別の fetch に上書きされる）。
 * remote の無いプロジェクトは HEAD。branch を切り替えても fast-forward なら入る（戻すと止まる）。
 */
export function commitOf(root: string, remote: boolean): string {
  if (remote) {
    try {
      git(root, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        "+HEAD:refs/gleanery/docs-head",
      ]);
    } catch (e) {
      const err = e as { code?: string; stderr?: Buffer };
      const detail =
        err.code === "ETIMEDOUT"
          ? "60 秒で終わらなかった"
          : (err.stderr?.toString().trim().split("\n").at(-1) ?? "");
      throw new Error(`remote の既定 branch を取れなかった（${detail}）。文書は前回の同期のまま`);
    }
    return git(root, ["rev-parse", "--verify", "refs/gleanery/docs-head^{commit}"]).toString().trim();
  }
  try {
    return git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
  } catch {
    throw new Error("commit が 1 つも無い");
  }
}

/** a が b の祖先か（a から b へ fast-forward できるか）。どちらかがこの clone に無ければ false。 */
export function isAncestor(root: string, a: string, b: string): boolean {
  try {
    git(root, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

type Entry = { mode: string; oid: string; size: number };
const FILE_MODES = new Set(["100644", "100755"]);

/** commit の tree 全体。**symlink（120000）とサブモジュール（160000）は本文として読まない。** */
export function treeOf(root: string, commit: string): { entries: Map<string, Entry>; dirs: Set<string> } {
  const entries = new Map<string, Entry>();
  const dirs = new Set<string>();
  for (const record of git(root, ["ls-tree", "-r", "-z", "-l", "--full-tree", commit])
    .toString("utf8")
    .split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , oid, size] = record.slice(0, tab).trim().split(/\s+/);
    const rel = record.slice(tab + 1);
    if (!mode || !oid) continue;
    entries.set(rel, { mode, oid, size: Number(size) || 0 });
    for (let d = path.posix.dirname(rel); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
  }
  return { entries, dirs };
}

/** blob を 1 回の `git cat-file --batch` でまとめて読む。clean / smudge の filter は通さない（commit の中身そのもの）。 */
export function blobsOf(root: string, oids: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (oids.length === 0) return out;
  const raw = git(root, ["cat-file", "--batch"], Buffer.from(`${[...new Set(oids)].join("\n")}\n`));
  let at = 0;
  while (at < raw.length) {
    const nl = raw.indexOf(10, at);
    const [oid, , size] = raw.subarray(at, nl).toString("utf8").split(" ");
    const n = Number(size);
    if (!oid || !Number.isFinite(n)) throw new Error("git cat-file の応答を読めなかった");
    out.set(oid, raw.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

/**
 * 文書ごとの最終更新日（その commit から遡って最後に触ったコミット）。**1 回の git log で全部取る。**
 * 観測時点の無い文書は、10 年前の記述でも今の事実として読まれる。取れなければ投げる（日付の無い節を書かない）。
 * pathspec は一覧の `/\.mdx?$/i` と同じく大文字小文字を区別しない（`README.MD` の日付を落とさない）。
 */
function lastTouched(root: string, commit: string): Map<string, string> {
  const at = new Map<string, string>();
  const out = git(root, [
    "-c",
    "core.quotepath=false",
    "log",
    commit,
    "--format=@%aI",
    "--name-only",
    "--",
    ":(icase)*.md",
    ":(icase)*.mdx",
  ]).toString("utf8");
  let cur = "";
  for (const line of out.split("\n")) {
    // 日付の形まで見る。`@` で始まるパスを日付と読むと、次のファイルがパスを日付として受け取る。
    if (/^@\d{4}-\d{2}-\d{2}T/.test(line)) cur = line.slice(1);
    else if (line && cur && !at.has(line)) at.set(line, cur);
  }
  return at;
}

/** 取り込まない path。file は完全一致、directory は `<path>/` で始まるもの（`fixtures-old` は当たらない）。 */
export type Excluded = { files: string[]; directories: string[] };

const EXCLUDE_NONE: Excluded = { files: [], directories: [] };

const excluded = (rel: string, ex: Excluded): boolean =>
  ex.files.includes(rel) || ex.directories.some((d) => rel.startsWith(`${d}/`));

/** 以前の要件定義・設計書の置き場所。承認していない下書きを検索に出さないよう、入れ子も含めて取り込まない。 */
const underGleanery = (rel: string): boolean => /(^|\/)\.gleanery\//.test(rel);

export type Doc = {
  path: string;
  title: string;
  body: string;
  at: string | null;
  sections: Section[];
};

/** 読んだ本文を文書の形へ投影する。 */
export function projectDocs(bodies: Map<string, string>, at: Map<string, string>): Doc[] {
  const out: Doc[] = [];
  for (const [rel, raw] of bodies) {
    const body = clean(raw);
    if (!body.trim()) continue;
    const title = body.match(/^#\s+(\S.*)$/m)?.[1]?.trim() ?? path.basename(rel);
    out.push({
      path: rel,
      title,
      body,
      at: at.get(rel) ?? null,
      sections: sections(rel, body),
    });
  }
  return out;
}

/**
 * 文書を行へ投影する形のバージョン。**節の割り方・札・metadata を変えたら上げる。**本文が同じでも hash が変わり、
 * 次の同期で全文書が書き直される（上げないと、古い形の節が残り続ける）。
 */
const PROJECTION = 2;

/** 文書 1 本の hash。**これが同じなら、その文書の行には一切書かない。**毎日の同期で全節を書き直さない。 */
export const docHash = (d: Doc): Buffer =>
  sha256(JSON.stringify([PROJECTION, d.path, d.title, d.body, d.at]));

// 1 文で渡す変数の数を SQLite の上限（32,766）より十分下に保つ。
const CHUNK = 500;
const chunks = <T>(xs: T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * commit の tree から、入れる文書を組み立てる（DB に触らない）。
 */
export function collectDocs(
  root: string,
  commit: string,
  ex: Excluded = EXCLUDE_NONE,
): { docs: Doc[]; skipped: number } {
  const tree = treeOf(root, commit);
  // **除外は blob を読む前に当てる。**読んでから捨てると、外したはずの本文が一度メモリへ載る。
  const md = [...tree.entries].filter(
    ([rel]) => /\.mdx?$/i.test(rel) && !excluded(rel, ex) && !underGleanery(rel),
  );
  const readable = md.filter(([, e]) => FILE_MODES.has(e.mode) && e.size <= MAX_FILE);
  const blobs = blobsOf(
    root,
    readable.map(([, e]) => e.oid),
  );
  const bodies = new Map(
    readable.map(([rel, e]) => {
      const b = blobs.get(e.oid);
      if (!b) throw new Error(`${rel} を読んでいない`);
      return [rel, b.toString("utf8")];
    }),
  );
  const skipped = md.filter(([, e]) => !FILE_MODES.has(e.mode)).length;
  return { docs: projectDocs(bodies, lastTouched(root, commit)), skipped };
}

/** docs の connector に付いた除外。connector がまだ無ければ空（最初の同期でも読める）。 */
export async function excludedOf(db: Kysely<DB>, projectId: number): Promise<Excluded> {
  const rows = await db
    .selectFrom("docs_exclude as x")
    .innerJoin("connector as c", (j) => j.onRef("c.id", "=", "x.connector_id").on("c.provider", "=", "docs"))
    .select(["x.kind", "x.path"])
    .where("c.project_id", "=", projectId)
    .execute();
  return {
    files: rows.flatMap((r) => (r.kind === "file" ? [r.path] : [])),
    directories: rows.flatMap((r) => (r.kind === "directory" ? [r.path] : [])),
  };
}

/**
 * 1 つのプロジェクトの文書を同期する。tree の一覧は完全なので、一覧から消えた文書は行ごと消す。
 *
 * **自動で進めるのは fast-forward だけ。**そうでなければ一度だけ取り直す。前に入れた commit 以降まで進んでいれば、
 * 同時に走った別の同期が新しい commit を先に入れたので、何も書かずに終える（別の PC が入れた commit は、取り直すまで
 * この clone に無い）。進んでいなければ巻き戻し・force-push・分岐した branch への切り替えで、どちらが正しいかを
 * 決められないので書かずに止まる（止まれば doctor と画面に出る。漏れた文書を巻き戻して消したときに黙って残さない）。
 * 今の状態に揃えるのは人の操作（reset）だけ。
 */
export async function syncDocs(
  db: Kysely<DB>,
  projectId: number,
  root: string,
  opts: { remote: boolean; reset?: boolean },
): Promise<string> {
  const commit = commitOf(root, opts.remote);
  const { docs, skipped } = collectDocs(root, commit, await excludedOf(db, projectId));

  const done = await inTransaction(db, async (trx) => {
    const connector = await connectorOf(trx, projectId, "docs");
    const before = connector.headOid;
    if (before && before !== commit && !opts.reset && !isAncestor(root, before, commit))
      return { refused: before, changed: 0, removed: 0 };
    const known = new Map(
      (
        await trx
          .selectFrom("source_item")
          .select(["external_id", "content_hash"])
          .where("connector_id", "=", connector.id)
          .execute()
      ).map((r) => [r.external_id, r.content_hash]),
    );
    const changed = docs.filter((d) => !known.get(d.path)?.equals(docHash(d)));
    const now = iso(Date.now());

    const sourceOf = new Map<string, number>();
    for (const part of chunks(changed))
      for (const r of await trx
        .insertInto("source_item")
        .values(
          part.map((d) => ({
            connector_id: connector.id,
            external_id: d.path,
            kind: "document",
            title: d.title,
            path: d.path,
            body: d.body,
            source_updated_at: d.at === null ? null : iso(d.at),
            content_hash: docHash(d),
            metadata: "{}",
            synced_at: now,
          })),
        )
        .onConflict((oc) =>
          oc.columns(["connector_id", "external_id"]).doUpdateSet((eb) => ({
            kind: eb.ref("excluded.kind"),
            title: eb.ref("excluded.title"),
            body: eb.ref("excluded.body"),
            source_updated_at: eb.ref("excluded.source_updated_at"),
            content_hash: eb.ref("excluded.content_hash"),
            metadata: eb.ref("excluded.metadata"),
            synced_at: eb.ref("excluded.synced_at"),
          })),
        )
        .returning(["id", "external_id"])
        .execute())
        sourceOf.set(r.external_id, r.id);
    const sections = changed.flatMap((d) =>
      d.sections.map((s) => ({
        s,
        source: sourceOf.get(d.path),
        at: d.at === null ? now : iso(d.at),
        hash: sha256(JSON.stringify([s.trail, s.text])),
      })),
    );
    // 節が消えた・key が変わったものを先に消す。残すと撤回した記述が検索で返る。
    const keep = new Set(sections.map((x) => x.s.key));
    const stale: number[] = [];
    for (const part of chunks([...sourceOf.values()]))
      for (const k of await trx
        .selectFrom("knowledge")
        .select(["id", "source_key"])
        .where("source_item_id", "in", part)
        .execute())
        if (!keep.has(k.source_key)) stale.push(k.id);
    for (const part of chunks(stale)) await trx.deleteFrom("knowledge").where("id", "in", part).execute();
    for (const part of chunks(sections))
      await trx
        .insertInto("knowledge")
        .values(
          part.map((x) => {
            if (x.source === undefined) throw new Error(`文書を書けなかった: ${x.s.key}`);
            return {
              project_id: projectId,
              source_item_id: x.source,
              source_key: x.s.key,
              kind: "document",
              heading: x.s.trail,
              body: x.s.text,
              occurred_at: x.at,
              content_hash: x.hash,
            };
          }),
        )
        .onConflict((oc) =>
          oc
            .columns(["project_id", "source_key"])
            .doUpdateSet((eb) => ({
              source_item_id: eb.ref("excluded.source_item_id"),
              heading: eb.ref("excluded.heading"),
              body: eb.ref("excluded.body"),
              occurred_at: eb.ref("excluded.occurred_at"),
              content_hash: eb.ref("excluded.content_hash"),
            }))
            .where("knowledge.content_hash", "<>", (eb) => eb.ref("excluded.content_hash")),
        )
        .execute();
    // git の一覧は完全なので、一覧から消えた文書は行ごと消す。
    const present = new Set(docs.map((d) => d.path));
    let removed = 0;
    for (const part of chunks([...known.keys()].filter((p) => !present.has(p))))
      removed += Number(
        (
          await trx
            .deleteFrom("source_item")
            .where("connector_id", "=", connector.id)
            .where("external_id", "in", part)
            .executeTakeFirst()
        ).numDeletedRows,
      );
    await trx
      .updateTable("connector")
      .set({ head_oid: commit, last_success_at: now, last_error: null })
      .where("id", "=", connector.id)
      .execute();
    return { refused: null, changed: changed.length, removed };
  });

  if (done.refused) {
    // 取り直しは transaction の外で行う（connector の行を掴んだまま、最大 60 秒の fetch を待たない）。
    const latest = commitOf(root, opts.remote);
    if (latest === done.refused || isAncestor(root, done.refused, latest))
      return `別の同期が新しい commit（${done.refused.slice(0, 8)}）を先に入れていたので、何も書かなかった`;
    throw new Error(
      `前に入れた commit（${done.refused.slice(0, 8)}）から ${opts.remote ? "remote の既定 branch" : "HEAD"}（${commit.slice(0, 8)}）へ ` +
        "fast-forward でないので書かなかった（巻き戻し・force-push・分岐した branch への切り替え）。" +
        `今の状態に揃えるなら \`gleanery harvest --cwd ${root} --reset-docs\``,
    );
  }
  const sectionCount = docs.reduce((n, d) => n + d.sections.length, 0);
  return [
    `文書 ${docs.length} 本・節 ${sectionCount} 件`,
    `書き直した ${done.changed} 本`,
    done.removed ? `消えた ${done.removed} 本` : null,
    skipped ? `symlink とサブモジュールを飛ばした ${skipped} 件` : null,
  ]
    .filter(Boolean)
    .join(" / ");
}
