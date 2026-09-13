// リポジトリの Markdown を、原文（source_item）と検索用の節（knowledge の document）にする。
//
// **コードは入れないが、文書は入れる。**設計文書と ADR は「なぜそうしたか」で、リポジトリが消えれば読む先も消える。
// **見出しで切る。**1 本を丸ごと 1 件にすると、長い設計書が 1 つのベクトルに潰れて何にも当たらない。
// **原文は別に持つ。**節は見出しだけの節を落とすので、連結しても元の Markdown に戻らない。画面は原文を出す。
//
// **正は remote の既定 branch の commit で、作業ツリーは読まない。**作業ツリーを読むと、どの PC の・どの branch の・
// 書きかけの状態が DB に入るかが同期した順で決まる（branch の切り替え、未 push の commit、古い clone で巻き戻る）。
// 一覧・本文・manifest・更新日を 1 つの commit の tree から読むので、読む順も filesystem の symlink も関係しない。

import { execFileSync } from "node:child_process";
import path from "node:path";
import type pg from "pg";
import { type Artifact, MAX_MANIFEST, type Snapshot, selectArtifacts, underMitos } from "./artifacts.ts";
import { EMBED_MODEL, inTransaction } from "./db.ts";
import { knowledgeText } from "./knowledge.ts";
import { connectorOf } from "./project.ts";
import { clean, sha256, tsvector } from "./text.ts";

export type Section = {
  /** 作業場所の中で一意な key。`doc:<path>#<見出し>` */
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
 * 同期する commit。remote を持つ作業場所は、remote の HEAD（既定 branch）をその場で取る。**ローカルの
 * origin/HEAD は読まない** — fetch だけでは既定 branch の名前変更に追随しない。取れなければ投げる（前回の状態を保つ）。
 * 取った先は専用の ref に置く（共有の FETCH_HEAD は同じ PC の別の fetch に上書きされる）。
 * remote の無い作業場所は HEAD。branch を切り替えても fast-forward なら入る（戻すと止まる）。
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
        "+HEAD:refs/mitos/docs-head",
      ]);
    } catch (e) {
      const err = e as { code?: string; stderr?: Buffer };
      const detail =
        err.code === "ETIMEDOUT"
          ? "60 秒で終わらなかった"
          : (err.stderr?.toString().trim().split("\n").at(-1) ?? "");
      throw new Error(`remote の既定 branch を取れなかった（${detail}）。文書は前回の同期のまま`);
    }
    return git(root, ["rev-parse", "--verify", "refs/mitos/docs-head^{commit}"]).toString().trim();
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

/** commit の tree を、成果物の検査の読み先にする。 */
function snapshotOf(tree: ReturnType<typeof treeOf>, blobs: Map<string, Buffer>): Snapshot {
  return {
    kind: (rel) => {
      const e = tree.entries.get(rel);
      if (e) return FILE_MODES.has(e.mode) ? "file" : "other";
      return tree.dirs.has(rel) ? "dir" : null;
    },
    size: (rel) => tree.entries.get(rel)?.size ?? 0,
    read: (rel) => {
      const e = tree.entries.get(rel);
      const b = e && blobs.get(e.oid);
      if (!b) throw new Error(`${rel} を読んでいない`);
      return b.toString("utf8");
    },
    tracked: new Set(tree.entries.keys()),
  };
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

export type Doc = {
  path: string;
  kind: "document" | "requirements" | "design";
  title: string;
  body: string;
  at: string | null;
  artifact?: Artifact | undefined;
  sections: Section[];
};

/** 読んだ本文を文書の形へ投影する。**`.mitos` 配下は承認済みの成果物だけを入れる。** */
export function projectDocs(
  bodies: Map<string, string>,
  include: Map<string, Artifact>,
  at: Map<string, string>,
): Doc[] {
  const out: Doc[] = [];
  for (const [rel, raw] of bodies) {
    const artifact = include.get(rel);
    if (underMitos(rel) && !artifact) continue;
    const body = clean(raw);
    if (!body.trim()) continue;
    const title = body.match(/^#\s+(\S.*)$/m)?.[1]?.trim() ?? path.basename(rel);
    out.push({
      path: rel,
      kind: artifact?.kind ?? "document",
      title,
      body,
      at: at.get(rel) ?? null,
      artifact,
      sections: sections(rel, body),
    });
  }
  return out;
}

/**
 * 文書を行へ投影する形の版。**節の割り方・札・metadata を変えたら上げる。**本文が同じでも hash が変わり、
 * 次の同期で全文書が書き直される（上げないと、古い形の節が残り続ける）。
 */
const PROJECTION = 1;

/** 文書 1 本の hash。**これが同じなら、その文書の行には一切書かない。**毎日の同期で全節を書き直さない。 */
export const docHash = (d: Doc): Buffer =>
  sha256(JSON.stringify([PROJECTION, d.kind, d.path, d.title, d.body, d.at, d.artifact ?? null]));

const CHUNK = 500;

/**
 * commit の tree から、入れる文書を組み立てる（DB に触らない）。`.mitos` が不正なら、どれが承認済みかを
 * 決められないので投げる（呼び出し側は何も書かず、前回の状態を保つ）。
 */
export function collectDocs(root: string, commit: string): { docs: Doc[]; skipped: number } {
  const tree = treeOf(root, commit);
  const md = [...tree.entries].filter(([rel]) => /\.mdx?$/i.test(rel));
  const readable = md.filter(([, e]) => FILE_MODES.has(e.mode) && e.size <= MAX_FILE);
  // 大きすぎる manifest は読まない（検査が大きさだけで「大きすぎる」と返す）。読み込んでから測ると、1 本で同期ごと落ちる。
  const manifests = [...tree.entries].filter(
    ([rel, e]) =>
      rel.startsWith(".mitos/") && rel.endsWith(".json") && FILE_MODES.has(e.mode) && e.size <= MAX_MANIFEST,
  );
  const snap = snapshotOf(
    tree,
    blobsOf(
      root,
      [...readable, ...manifests].map(([, e]) => e.oid),
    ),
  );
  const bodies = new Map(readable.map(([rel]) => [rel, snap.read(rel)]));
  const { include, problems } = selectArtifacts(snap, [...bodies.keys()]);
  if (problems.length) {
    throw new Error(
      `.mitos が不正なので、この作業場所の文書を同期しない（前回の状態を保つ）:\n${problems
        .map((p) => `  ${p.path}: ${p.reason}`)
        .join("\n")}`,
    );
  }
  const skipped = md.filter(([, e]) => !FILE_MODES.has(e.mode)).length;
  return { docs: projectDocs(bodies, include, lastTouched(root, commit)), skipped };
}

/**
 * 1 つの作業場所の文書を同期する。tree の一覧は完全なので、一覧から消えた文書は行ごと消す。
 *
 * **自動で進めるのは fast-forward だけ。**そうでなければ一度だけ取り直す。前に入れた commit 以降まで進んでいれば、
 * 同時に走った別の同期が新しい commit を先に入れたので、何も書かずに終える（別の PC が入れた commit は、取り直すまで
 * この clone に無い）。進んでいなければ巻き戻し・force-push・分岐した branch への切り替えで、どちらが正しいかを
 * 決められないので書かずに止まる（止まれば doctor と画面に出る。漏れた文書を巻き戻して消したときに黙って残さない）。
 * 今の状態に揃えるのは人の操作（reset）だけ。
 */
export async function syncDocs(
  client: pg.Client,
  projectId: number,
  root: string,
  opts: { remote: boolean; reset?: boolean },
): Promise<string> {
  const commit = commitOf(root, opts.remote);
  const { docs, skipped } = collectDocs(root, commit);

  const done = await inTransaction(client, async () => {
    const connector = await connectorOf(client, projectId, "docs");
    const before = connector.headOid;
    if (before && before !== commit && !opts.reset && !isAncestor(root, before, commit)) {
      const latest = commitOf(root, opts.remote);
      if (latest === before || isAncestor(root, before, latest))
        return { refused: null, newer: before, changed: 0, removed: 0 };
      return { refused: before, newer: null, changed: 0, removed: 0 };
    }
    const known = new Map(
      (
        await client.query<{ external_id: string; content_hash: Buffer }>(
          "select external_id, content_hash from mitos.source_item where connector_id = $1",
          [connector.id],
        )
      ).rows.map((r) => [r.external_id, r.content_hash]),
    );
    const changed = docs.filter((d) => !known.get(d.path)?.equals(docHash(d)));

    if (changed.length) {
      const items = await client.query<{ id: string; external_id: string }>(
        `insert into mitos.source_item (connector_id, external_id, kind, title, path, body, source_updated_at,
                                        content_hash, metadata, synced_at)
         select $1, t.path, t.kind, t.title, t.path, t.body, t.at, decode(t.hash, 'hex'), t.metadata, now()
         from jsonb_to_recordset($2::jsonb) as t(path text, kind text, title text, body text, at timestamptz,
                                                 hash text, metadata jsonb)
         on conflict (connector_id, external_id) do update set
           kind = excluded.kind, title = excluded.title, body = excluded.body,
           source_updated_at = excluded.source_updated_at, content_hash = excluded.content_hash,
           metadata = excluded.metadata, synced_at = now()
         returning id, external_id`,
        [
          connector.id,
          JSON.stringify(
            changed.map((d) => ({
              path: d.path,
              kind: d.kind,
              title: d.title,
              body: d.body,
              at: d.at,
              hash: docHash(d).toString("hex"),
              metadata: d.artifact ? { change: d.artifact.change, changeTitle: d.artifact.changeTitle } : {},
            })),
          ),
        ],
      );
      const sourceOf = new Map(items.rows.map((r) => [r.external_id, r.id]));
      const sections = changed.flatMap((d) =>
        d.sections.map((s) => {
          const row = { kind: "document", heading: s.trail, body: s.text, reason: null };
          return {
            s,
            source: sourceOf.get(d.path),
            at: d.at,
            hash: sha256(knowledgeText(row)),
            lex: tsvector(`${s.trail}\n${s.text}`),
          };
        }),
      );
      // 節が消えた・key が変わったものを先に消す。残すと撤回した記述が検索で返る。
      await client.query(
        "delete from mitos.knowledge where source_item_id = any($1::bigint[]) and not (source_key = any($2))",
        [[...sourceOf.values()], sections.map((x) => x.s.key)],
      );
      for (let i = 0; i < sections.length; i += CHUNK) {
        const part = sections.slice(i, i + CHUNK);
        const written = await client.query<{ id: string; content_hash: Buffer }>(
          `insert into mitos.knowledge (project_id, source_item_id, source_key, kind, heading, body, occurred_at,
                                        content_hash, lexemes)
           select $1, t.source, t.key, 'document', t.heading, t.body, coalesce(t.at, now()), t.hash, t.lex::tsvector
           from unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::bytea[], $8::text[])
             as t(source, key, heading, body, at, hash, lex)
           on conflict (project_id, source_key) do update set
             source_item_id = excluded.source_item_id, heading = excluded.heading, body = excluded.body,
             occurred_at = excluded.occurred_at, content_hash = excluded.content_hash, lexemes = excluded.lexemes
           where mitos.knowledge.content_hash <> excluded.content_hash
           returning id, content_hash`,
          [
            projectId,
            part.map((x) => x.source),
            part.map((x) => x.s.key),
            part.map((x) => x.s.trail),
            part.map((x) => x.s.text),
            part.map((x) => x.at),
            part.map((x) => x.hash),
            part.map((x) => x.lex),
          ],
        );
        await client.query(
          `insert into mitos.knowledge_embedding (knowledge_id, model, source_hash, status)
           select t.id, $3, t.hash, 'pending' from unnest($1::bigint[], $2::bytea[]) as t(id, hash)
           on conflict (knowledge_id) do update set
             source_hash = excluded.source_hash, status = 'pending', embedding = null, attempts = 0, last_error = null,
             updated_at = now()
           where mitos.knowledge_embedding.source_hash <> excluded.source_hash`,
          [written.rows.map((r) => r.id), written.rows.map((r) => r.content_hash), EMBED_MODEL],
        );
      }
    }
    // git の一覧は完全なので、一覧から消えた文書（承認を外した成果物を含む）は行ごと消す。
    const removed = await client.query(
      "delete from mitos.source_item where connector_id = $1 and not (external_id = any($2))",
      [connector.id, docs.map((d) => d.path)],
    );
    await client.query(
      "update mitos.connector set head_oid = $2, last_success_at = now(), last_error = null where id = $1",
      [connector.id, commit],
    );
    return { refused: null, newer: null, changed: changed.length, removed: removed.rowCount ?? 0 };
  });

  if (done.refused)
    throw new Error(
      `前に入れた commit（${done.refused.slice(0, 8)}）から ${opts.remote ? "remote の既定 branch" : "HEAD"}（${commit.slice(0, 8)}）へ ` +
        "fast-forward でないので書かなかった（巻き戻し・force-push・分岐した branch への切り替え）。" +
        `今の状態に揃えるなら \`mitos sync --cwd ${root} --reset-docs\``,
    );
  if (done.newer)
    return `別の同期が新しい commit（${done.newer.slice(0, 8)}）を先に入れていたので、何も書かなかった`;
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
