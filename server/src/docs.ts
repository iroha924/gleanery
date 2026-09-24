// Turns the repository's Markdown into source text (source_item) and searchable sections (knowledge of kind document).
//
// **Code is not imported, documents are.** Design docs and ADRs say why things are the way they are, and they vanish with the repository.
// **Split at headings.** One entry per file mixes the terms of a long design doc into one hit and hides which section it came from.
// **The source text is kept separately.** Heading-only sections are dropped, so joining sections does not restore the Markdown. Screens show the source.
//
// **The truth is the commit on the remote's default branch; the working tree is never read.** Reading it would let sync order decide which
// machine's, which branch's, half-written state lands in the database (branch switches, unpushed commits, and old clones would roll it back).
// The list, bodies, manifest, and dates all come from one commit's tree, so read order and filesystem symlinks do not matter.

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Kysely } from "kysely";
import { inTransaction, iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { connectorOf } from "./project.ts";
import { clean, plural, sha256 } from "./text.ts";

export type Section = {
  /** A key unique within the project: `doc:<path>#<heading>` */
  key: string;
  path: string;
  title: string;
  /** The path of ancestor headings. It becomes the search heading */
  trail: string;
  text: string;
};

/** Limit for one section. **The excess moves to the next section instead of being dropped.** Once the repository is gone it cannot be fetched again. */
const MAX = 4000;
/** Limit for one file. A .md file larger than this is not a document (a generated file or misplaced data). */
const MAX_FILE = 2 * 1024 * 1024;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[`*_[\]()#]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "body";

/**
 * Splits at headings. **Code fences are skipped.** Shell comments and frontmatter delimiters would turn into headings.
 * A fence closes only on a line with the same character, at least the same length, and no info string (CommonMark).
 * Reading three backticks inside an example fenced with four as a close would turn headings in the example into sections.
 */
export function sections(rel: string, body: string): Section[] {
  // JS `.` treats `\r` as a line terminator, so CRLF headings would not match. A BOM would drop the first heading.
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
    // Heading-only sections are not stored. Their children hold the content, and the heading stays in the children's trail.
    if (cur.level > 0 && raw === cur.buf.find((l) => l.trim())?.trim()) return;
    // Split at the limit, between paragraphs — cutting mid-sentence makes both sides unreadable.
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
      // Sections with the same title appear many times in one file (such as "## Background"). Without numbers the last one would win.
      // Keys are unique across all used keys, so a numbered key never collides with another heading ("## Background:2").
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
    // Not `.*\S`. It competes with ` +` and goes quadratic in line length; one line of 80,000 spaces stalls for seconds.
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

// Unattended syncs (launchd) never stop waiting for credentials.
const git = (root: string, args: string[], input?: Buffer): Buffer =>
  execFileSync("git", ["-C", root, ...args], {
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

/**
 * The commit to sync. For projects with a remote, the remote's HEAD (default branch) is fetched on the spot. **The local
 * origin/HEAD is not read** — fetch alone does not follow a renamed default branch. Throws when it cannot fetch (the previous state stays).
 * The fetched commit goes to a dedicated ref (the shared FETCH_HEAD is overwritten by other fetches on the same machine).
 * Projects without a remote use HEAD. Switching branches is imported when it is a fast-forward (going back stops).
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
          ? "did not finish in 60 seconds"
          : (err.stderr?.toString().trim().split("\n").at(-1) ?? "");
      throw new Error(
        `Could not fetch the remote's default branch (${detail}). Documents stay as of the last sync.`,
      );
    }
    return git(root, ["rev-parse", "--verify", "refs/gleanery/docs-head^{commit}"]).toString().trim();
  }
  try {
    return git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
  } catch {
    throw new Error("There are no commits");
  }
}

/** Whether a is an ancestor of b (b is a fast-forward from a). false when either is not in this clone. */
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

/** The whole tree of a commit. **Symlinks (120000) and submodules (160000) are not read as text.** */
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

/** Reads blobs with one `git cat-file --batch`. No clean / smudge filters (the commit's exact content). */
export function blobsOf(root: string, oids: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (oids.length === 0) return out;
  const raw = git(root, ["cat-file", "--batch"], Buffer.from(`${[...new Set(oids)].join("\n")}\n`));
  let at = 0;
  while (at < raw.length) {
    const nl = raw.indexOf(10, at);
    const [oid, , size] = raw.subarray(at, nl).toString("utf8").split(" ");
    const n = Number(size);
    if (!oid || !Number.isFinite(n)) throw new Error("Could not read the git cat-file response");
    out.set(oid, raw.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

/**
 * The last update date of each document (the last commit touching it, going back from that commit). **One git log for all.**
 * A document without a date reads as current fact even when written ten years ago. Throws when unavailable (no undated sections are written).
 * The pathspec is case-insensitive like the list's `/\.mdx?$/i` (so `README.MD` keeps its date).
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
    // Check the date format too. Reading a path starting with `@` as a date would give the next file a path as its date.
    if (/^@\d{4}-\d{2}-\d{2}T/.test(line)) cur = line.slice(1);
    else if (line && cur && !at.has(line)) at.set(line, cur);
  }
  return at;
}

/** Paths not imported. file is an exact match; directory matches paths starting with `<path>/` (`fixtures-old` does not match). */
export type Excluded = { files: string[]; directories: string[] };

const EXCLUDE_NONE: Excluded = { files: [], directories: [] };

const excluded = (rel: string, ex: Excluded): boolean =>
  ex.files.includes(rel) || ex.directories.some((d) => rel.startsWith(`${d}/`));

/** Where requirements and design docs used to live. Excluded with nested paths so unapproved drafts never reach search. */
const underGleanery = (rel: string): boolean => /(^|\/)\.gleanery\//.test(rel);

export type Doc = {
  path: string;
  title: string;
  body: string;
  at: string | null;
  sections: Section[];
};

/** Projects the text that was read into the document shape. */
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
 * Version of how documents are projected into rows. **Bump it when splitting, labels, or metadata change.** The hash changes even
 * for the same text, and the next sync rewrites every document (without it, sections in the old shape stay).
 */
const PROJECTION = 3;

/** Hash of one document. **When it matches, nothing is written to that document's rows.** Daily syncs do not rewrite every section. */
export const docHash = (d: Doc): Buffer =>
  sha256(JSON.stringify([PROJECTION, d.path, d.title, d.body, d.at]));

// Keep the number of variables per statement well below SQLite's limit (32,766).
const CHUNK = 500;
const chunks = <T>(xs: T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Builds the documents to import from a commit's tree (without touching the database).
 */
export function collectDocs(
  root: string,
  commit: string,
  ex: Excluded = EXCLUDE_NONE,
): { docs: Doc[]; skipped: number } {
  const tree = treeOf(root, commit);
  // **Apply exclusions before reading blobs.** Reading then discarding would load excluded text into memory once.
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
      if (!b) throw new Error(`${rel} was not read`);
      return [rel, b.toString("utf8")];
    }),
  );
  const skipped = md.filter(([, e]) => !FILE_MODES.has(e.mode)).length;
  return { docs: projectDocs(bodies, lastTouched(root, commit)), skipped };
}

/** Exclusions on the docs connector. Empty when the connector does not exist yet (the first sync can still read them). */
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
 * Syncs one project's documents. The tree list is complete, so documents gone from it are deleted with their rows.
 *
 * **Only fast-forwards advance automatically.** Otherwise it fetches once more. If the stored commit has moved past the refused one,
 * another concurrent sync stored a newer commit first, so this ends without writing (a commit stored by another machine is not in
 * this clone until fetched). If not, it is a rollback, force push, or switch to a diverged branch, and it cannot tell which is right,
 * so it stops without writing (doctor and the dashboard show it; a leaked document removed by rollback is never kept silently).
 * Only a person (reset) brings it to the current state.
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
    // Delete sections that disappeared or changed key first. Keeping them would return withdrawn text in search.
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
            if (x.source === undefined) throw new Error(`Could not write the document: ${x.s.key}`);
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
    // The git list is complete, so documents gone from it are deleted with their rows.
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
    // Fetch again outside the transaction (do not hold the connector row while waiting up to 60 seconds for fetch).
    const latest = commitOf(root, opts.remote);
    if (latest === done.refused || isAncestor(root, done.refused, latest))
      return `another sync stored a newer commit (${done.refused.slice(0, 8)}) first, so nothing was written`;
    throw new Error(
      `The stored commit (${done.refused.slice(0, 8)}) is not a fast-forward to ${opts.remote ? "the remote's default branch" : "HEAD"} (${commit.slice(0, 8)}), ` +
        "so nothing was written (a rollback, force push, or switch to a diverged branch). " +
        `To match the current state, run \`gleanery harvest --cwd ${root} --reset-docs\``,
    );
  }
  const sectionCount = docs.reduce((n, d) => n + d.sections.length, 0);
  return [
    `${plural(docs.length, "document")}, ${plural(sectionCount, "section")}`,
    `${done.changed} rewritten`,
    done.removed ? `${done.removed} removed` : null,
    skipped ? `${plural(skipped, "symlink or submodule", "symlinks and submodules")} skipped` : null,
  ]
    .filter(Boolean)
    .join(" / ");
}
