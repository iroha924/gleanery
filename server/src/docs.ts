// リポジトリの Markdown を、原文（source_item）と検索用の節（knowledge の document）にする。
//
// **コードは入れないが、文書は入れる。**設計文書と ADR は「なぜそうしたか」で、リポジトリが消えれば読む先も消える。
// **見出しで切る。**1 本を丸ごと 1 件にすると、長い設計書が 1 つのベクトルに潰れて何にも当たらない。
// **原文は別に持つ。**節は見出しだけの節を落とすので、連結しても元の Markdown に戻らない。画面は原文を出す。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { type Artifact, selectArtifacts, underMitos } from "./artifacts.ts";
import { EMBED_MODEL, type Env, inTransaction } from "./db.ts";
import { fillKnowledge } from "./embeddings.ts";
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
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      out.push({
        key: n === 1 && parts.length === 1 ? base : `${base}:${n}`,
        path: rel,
        title: cur.title,
        trail: cur.trail,
        text,
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

/**
 * 文書ごとの最終更新日（最後に触ったコミット）。**1 回の git log で全部取る。**
 * 観測時点の無い文書は、10 年前の記述でも今の事実として読まれる。
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
    return at;
  }
  let cur = "";
  for (const line of out.split("\n")) {
    // 日付の形まで見る。`@` で始まるパスを日付と読むと、次のファイルがパスを日付として受け取る。
    if (/^@\d{4}-\d{2}-\d{2}T/.test(line)) cur = line.slice(1);
    else if (line && cur && !at.has(line)) at.set(line, cur);
  }
  return at;
}

/**
 * その作業場所で git が追っている Markdown。**自前で走査しない**（gitignore と node_modules を避ける）。
 *
 * **symlink は返さない。**git は追跡された symlink を列挙し、読む側はその先を開く。
 * `docs/setup.md -> ~/.claude/knowledge.env` が 1 本あれば、無人の同期が資格情報を本文として保存する。
 * 途中のディレクトリが外への symlink の場合もあるので、realpath の前方一致で見る。
 */
export function markdownFiles(dir: string): { files: string[]; symlinks: number } {
  const out = execFileSync("git", ["-C", dir, "ls-files", "-z", "*.md", "*.mdx"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      continue; // git は追っているが手元に無い（sparse checkout、消したまま未コミット）
    }
    if (st.isSymbolicLink() || !(real === base || real.startsWith(`${base}${path.sep}`))) {
      symlinks++;
      continue;
    }
    if (st.size > MAX_FILE) continue;
    files.push(rel);
  }
  return { files, symlinks };
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

/** 文書 1 本の hash。**これが同じなら、その文書の行には一切書かない。**毎日の同期で全節を書き直さない。 */
export const docHash = (d: Doc): Buffer =>
  sha256(JSON.stringify([d.kind, d.path, d.title, d.body, d.at, d.artifact ?? null]));

const CHUNK = 500;

/** 1 つの作業場所の文書を同期する。git の一覧は完全なので、一覧から消えた文書は行ごと消す。 */
export async function syncDocs(
  client: pg.Client,
  env: Env,
  projectId: number,
  root: string,
  say: (m: string) => void = () => {},
): Promise<string> {
  const { files, symlinks } = markdownFiles(root);
  const at = lastTouched(root);
  const bodies = new Map<string, string>();
  for (const rel of files) {
    try {
      bodies.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
    } catch {
      // 列挙と読み取りの間に消えた
    }
  }
  // **本文を読み終えてから manifest を読む。**再編集は draft を書いてから本文を触るので、この順なら
  // 編集中の本文は必ず draft として外れる。不正なら、どれが承認済みかを決められないので何も書かない。
  const { include, problems } = selectArtifacts(root, [...bodies.keys()]);
  if (problems.length) {
    throw new Error(
      `.mitos が不正なので、この作業場所の文書を同期しない（前回の状態を保つ）:\n${problems
        .map((p) => `  ${p.path}: ${p.reason}`)
        .join("\n")}`,
    );
  }
  const docs = projectDocs(bodies, include, at);

  const { changed, removed } = await inTransaction(client, async () => {
    const connectorId = await connectorOf(client, projectId, "docs");
    const known = new Map(
      (
        await client.query<{ id: string; external_id: string; content_hash: Buffer }>(
          "select id, external_id, content_hash from mitos.source_item where connector_id = $1",
          [connectorId],
        )
      ).rows.map((r) => [r.external_id, r]),
    );
    const changed = docs.filter((d) => !known.get(d.path)?.content_hash.equals(docHash(d)));

    for (const d of changed) {
      const item = await client.query<{ id: string }>(
        `insert into mitos.source_item (connector_id, external_id, kind, title, path, body, source_updated_at,
                                        content_hash, metadata, synced_at)
         values ($1, $2, $3, $4, $2, $5, $6, $7, $8, now())
         on conflict (connector_id, external_id) do update set
           kind = excluded.kind, title = excluded.title, body = excluded.body,
           source_updated_at = excluded.source_updated_at, content_hash = excluded.content_hash,
           metadata = excluded.metadata, synced_at = now()
         returning id`,
        [
          connectorId,
          d.path,
          d.kind,
          d.title,
          d.body,
          d.at,
          docHash(d),
          JSON.stringify(
            d.artifact ? { change: d.artifact.change, changeTitle: d.artifact.changeTitle } : {},
          ),
        ],
      );
      const sourceId = item.rows[0]?.id;
      if (!sourceId) throw new Error(`文書を書けなかった: ${d.path}`);
      // 節が消えた・key が変わったものを先に消す。残すと撤回した記述が検索で返る。
      await client.query(
        "delete from mitos.knowledge where source_item_id = $1 and not (source_key = any($2))",
        [sourceId, d.sections.map((s) => s.key)],
      );
      for (let i = 0; i < d.sections.length; i += CHUNK) {
        const part = d.sections.slice(i, i + CHUNK).map((s) => {
          const row = { kind: "document", heading: s.trail, body: s.text, reason: null };
          return { s, hash: sha256(knowledgeText(row)), lex: tsvector(`${s.trail}\n${s.text}`) };
        });
        const written = await client.query<{ id: string; content_hash: Buffer }>(
          `insert into mitos.knowledge (project_id, source_item_id, source_key, kind, heading, body, occurred_at,
                                        content_hash, lexemes)
           select $1, $2, t.key, 'document', t.heading, t.body, coalesce($3::timestamptz, now()), t.hash, t.lex::tsvector
           from unnest($4::text[], $5::text[], $6::text[], $7::bytea[], $8::text[]) as t(key, heading, body, hash, lex)
           on conflict (project_id, source_key) do update set
             source_item_id = excluded.source_item_id, heading = excluded.heading, body = excluded.body,
             occurred_at = excluded.occurred_at, content_hash = excluded.content_hash, lexemes = excluded.lexemes
           where mitos.knowledge.content_hash <> excluded.content_hash
           returning id, content_hash`,
          [
            projectId,
            sourceId,
            d.at,
            part.map((x) => x.s.key),
            part.map((x) => x.s.trail),
            part.map((x) => x.s.text),
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
    const live = docs.map((d) => d.path);
    const removed = await client.query(
      "delete from mitos.source_item where connector_id = $1 and not (external_id = any($2))",
      [connectorId, live],
    );
    await client.query(
      "update mitos.connector set last_success_at = now(), last_error = null where id = $1",
      [connectorId],
    );
    return { changed, removed: removed.rowCount ?? 0 };
  });

  const sectionCount = docs.reduce((n, d) => n + d.sections.length, 0);
  say(`文書 ${docs.length} 本 / 節 ${sectionCount} 件 / 書き直した文書 ${changed.length} 本`);
  const filled = await fillKnowledge(client, env);
  return [
    `文書 ${docs.length} 本・節 ${sectionCount} 件`,
    `書き直した ${changed.length} 本`,
    removed ? `消えた ${removed} 本` : null,
    `埋め込み ${filled.embedded} 件${filled.failed ? `（失敗 ${filled.failed} 件。次の同期で取り直す）` : ""}`,
    symlinks ? `symlink を飛ばした ${symlinks} 件` : null,
  ]
    .filter(Boolean)
    .join(" / ");
}
