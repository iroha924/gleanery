// Looks after this machine's database (~/.sphica/sphica.db). The owner runs these locally, with the owner connection (no authorizer).
//
//   sphica init                 creates the database and applies db/schema.sql. Safe to run again (an existing one is left alone)
//   sphica db migrate [--yes]   applies db/migrations newer than the database version (user_version)
//   sphica db reindex           rebuilds the full-text index (FTS). Run it after changing the rules of terms() in server/src/text.ts

import fs from "node:fs";
import path from "node:path";
import { constants as C, type DatabaseSync } from "node:sqlite";
import { confirm, isCancel } from "@clack/prompts";
import { dbDir } from "./assets.ts";
import { indent } from "./cli/view.ts";
import { dbFile, SCHEMA_REVISION } from "./db.ts";
import { connectWriter } from "./db-write.ts";
import { plain } from "./panel.ts";
import { searchTerms } from "./terms.ts";
import { plural } from "./text.ts";

/** Indented like other CLI output (the db command in cli.ts adds the heading and closing) */
const say = (text: string) => console.log(indent(text));

// assets.ts alone decides where bundled files live (the shipped package and the working tree differ).
const SCHEMA = (): string => path.join(dbDir(), "schema.sql");
const MIGRATIONS = (): string => path.join(dbDir(), "migrations");

const versionOf = (raw: DatabaseSync): number =>
  (raw.prepare("pragma user_version").get() as { user_version: number }).user_version;

/** Runs fn in a transaction that takes the write lock first. On failure it rolls back and rethrows the original error. */
function immediate<T>(raw: DatabaseSync, fn: () => T): T {
  raw.exec("begin immediate");
  try {
    const out = fn();
    raw.exec("commit");
    return out;
  } catch (e) {
    raw.exec("rollback");
    throw e;
  }
}

/** Opens a connection, runs fn, and always closes it. */
function withOwner<T>(file: string, fn: (raw: DatabaseSync) => T, create = false): T {
  const raw = connectWriter("owner", file, create);
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

/**
 * Prepares this machine's database. **An existing one is left alone**, so it is safe to run again.
 * The schema is applied to a temporary file before it is put in place (stopping midway never leaves a half-applied database).
 * If the destination is already taken, it stops without placing it.
 */
export function dbInit(file: string = dbFile()): void {
  if (fs.existsSync(file)) {
    const got = withOwner(file, versionOf);
    if (got === SCHEMA_REVISION) say(`Already exists: ${file} (revision ${got})`);
    else if (got === 0)
      throw new Error(
        `${file} is not a Sphica database (no schema). Move it to another name, then run this again.`,
      );
    else
      say(
        `Already exists: ${file} (revision ${got}; this Sphica expects ${SCHEMA_REVISION}. Run \`sphica db migrate\`.)`,
      );
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    withOwner(
      tmp,
      (raw) => {
        // WAL is a setting stored in the database file, so it need not be set per connection. Readers (MCP) do not wait for writers (imports).
        raw.exec("pragma journal_mode = wal");
        raw.exec(fs.readFileSync(SCHEMA(), "utf8"));
        if (versionOf(raw) !== SCHEMA_REVISION)
          throw new Error(
            `db/schema.sql has user_version ${versionOf(raw)}, but the code expects ${SCHEMA_REVISION}`,
          );
      },
      true,
    );
    // rename replaces a database already in place. link stops with EEXIST when the destination is taken (the later of two concurrent inits).
    // File systems without hard links (FAT, exFAT) fall back to rename. Copying is not used: stopping midway leaves a partial database.
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || fs.existsSync(file))
        throw new Error(
          `${file} already exists (another sphica init created it first). Run this again to check it.`,
        );
      fs.renameSync(tmp, file);
    }
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
  say(`Created: ${file} (revision ${SCHEMA_REVISION})`);
}

/**
 * NNNN in a name is the version after applying it. Name format and duplicates are checked even with nothing to apply (a skipped one never applies once the version moves on).
 */
export function pendingMigrations(files: string[], current: number): { revision: number; file: string }[] {
  const all = files
    // Names starting with `.` are OS or editor hidden files (.DS_Store, vim swap files), not misnamed migrations.
    .filter((file) => !file.startsWith("."))
    .map((file) => {
      const revision = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/)?.[1];
      if (!revision)
        throw new Error(`db/migrations/${file} is not named NNNN_<lowercase letters, digits, _>.sql`);
      return { revision: Number(revision), file };
    })
    .sort((a, b) => a.revision - b.revision);
  const seen = new Map<number, string>();
  for (const m of all) {
    const other = seen.get(m.revision);
    if (other)
      throw new Error(`db/migrations has two migrations for revision ${m.revision}: ${other} and ${m.file}`);
    seen.set(m.revision, m.file);
  }
  const pending = all.filter((m) => m.revision > current);
  for (const [i, m] of pending.entries()) {
    if (m.revision !== current + 1 + i)
      throw new Error(`db/migrations has no migration for revision ${current + 1 + i}`);
  }
  return pending;
}

/**
 * The declaration on a migration's first line. Only `-- sphica: foreign_keys=off` is accepted; any other `-- sphica:` throws.
 * **Misreading it and applying with foreign keys on lets a table rebuild cascade-delete child rows.** Leading spaces also count as a declaration.
 * The authorizer in applyMigrations stops undeclared migrations from dropping tables (not judged from the SQL text).
 */
function directiveOf(dir: string, m: { file: string }): "foreign_keys=off" | null {
  const lines = fs.readFileSync(path.join(dir, m.file), "utf8").split(/\r?\n/);
  let found: "foreign_keys=off" | null = null;
  for (const [i, line] of lines.entries()) {
    const d = /^\s*--\s*sphica:\s*(.*?)\s*$/.exec(line)?.[1];
    if (d === undefined) continue;
    if (i !== 0 || d !== "foreign_keys=off")
      throw new Error(`Cannot read the declaration on line ${i + 1} of db/migrations/${m.file}: ${d}`);
    found = d;
  }
  return found;
}

/**
 * Applies migrations newer than the database version and raises user_version per transaction (earlier ones stay if it fails midway, so it can be rerun).
 * Undeclared migrations in a row are applied in one transaction. A migration declaring `-- sphica: foreign_keys=off` runs alone,
 * turning foreign keys off outside the transaction, checks foreign_key_check is empty before commit, and turns them back on (they cannot switch inside a transaction).
 */
export function applyMigrations(
  raw: DatabaseSync,
  files: string[],
  dir: string,
): { revision: number; file: string }[] {
  // Read every declaration before applying. If one cannot be read, nothing is applied.
  const pending = pendingMigrations(files, versionOf(raw));
  const off = new Set(pending.filter((m) => directiveOf(dir, m) !== null).map((m) => m.file));
  const applied: { revision: number; file: string }[] = [];
  for (;;) {
    const next = pendingMigrations(files, versionOf(raw))[0];
    if (!next) return applied;
    const single = off.has(next.file);
    if (single) {
      raw.exec("pragma foreign_keys = off");
      if ((raw.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys !== 0)
        throw new Error("Could not turn foreign keys off (inside a transaction)");
    }
    // Undeclared migrations may not drop or rebuild tables (ALTER, including adding columns, belongs in a declared migration).
    // A drop with foreign keys on cascade-deletes child rows, and renaming a parent rewrites children's foreign keys to the backup.
    // It stops on statements SQLite has parsed, so comments or line breaks in between do not slip through.
    if (!single)
      raw.setAuthorizer((action) =>
        action === C.SQLITE_DROP_TABLE || action === C.SQLITE_ALTER_TABLE ? C.SQLITE_DENY : C.SQLITE_OK,
      );
    try {
      const batch = immediate(raw, () => {
        // Read again after taking the lock. If another db migrate advanced it meanwhile, apply the rest from there.
        const now = pendingMigrations(files, versionOf(raw));
        if (now[0]?.file !== next.file) return [];
        const stop = now.findIndex((m) => off.has(m.file));
        const take = single ? [next] : now.slice(0, stop === -1 ? now.length : stop);
        for (const m of take) raw.exec(fs.readFileSync(path.join(dir, m.file), "utf8"));
        if (single) {
          const broken = raw.prepare("pragma foreign_key_check").all();
          if (broken.length)
            throw new Error(`${plural(broken.length, "foreign key reference")} broken after ${next.file}`);
        }
        raw.exec(`pragma user_version = ${(take.at(-1) as { revision: number }).revision}`);
        return take;
      });
      applied.push(...batch);
    } finally {
      if (single) raw.exec("pragma foreign_keys = on");
      else raw.setAuthorizer(null);
    }
  }
}

/** What migrate did. The CLI closes with Stopped only for cancelled (declining is not "done") */
export type Migrated = "applied" | "up-to-date" | "cancelled";

/** Asks in the terminal. No is the default, and Esc, Ctrl-C, and a closed stdin all count as no */
const askToApply = async (): Promise<boolean> => {
  const answer = await confirm({ message: "Apply these migrations?", initialValue: false });
  return !isCancel(answer) && answer;
};

/**
 * Applies migrations newer than the database version. See applyMigrations for how.
 * **Lists them for confirmation before applying.** Without a terminal it cannot ask, so `--yes` is required.
 */
export async function migrate(
  yes: boolean,
  file: string = dbFile(),
  dir: string = MIGRATIONS(),
  ask: () => Promise<boolean> = askToApply,
): Promise<Migrated> {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const current = withOwner(file, versionOf);
  const todo = pendingMigrations(files, current);
  if (todo.length === 0) {
    say(`Nothing to apply: ${file} is at revision ${current}`);
    return "up-to-date";
  }
  say(`DB: ${file}`);
  say(`Current revision: ${current}`);
  say(`To apply: ${todo.map((m) => m.file).join(" / ")}`);
  if (!yes) {
    if (ask === askToApply && !process.stdin.isTTY)
      throw new Error("Add --yes when not running in a terminal");
    if (!(await ask())) return "cancelled";
  }
  const applied = withOwner(file, (raw) => applyMigrations(raw, files, dir));
  say(`Applied: ${applied.map((m) => m.file).join(" / ") || "none"}`);
  say(`${file} is at revision ${withOwner(file, versionOf)}`);
  return "applied";
}

/**
 * Rebuilds the full-text index. **A PR changing the rules of terms() adds this to its release steps.**
 * Changing the rules leaves existing rows indexed with the old rules, and they stop matching query terms.
 */
export function reindex(file: string = dbFile()): void {
  const counts = withOwner(file, (raw) =>
    immediate(raw, () => {
      raw.exec("insert into knowledge_fts (knowledge_fts) values ('delete-all')");
      raw.exec("insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text");
      raw.exec("insert into message_fts (message_fts) values ('delete-all')");
      raw.exec(
        "insert into message_fts (rowid, lexemes) select seq, sphica_terms(body) from message where indexed = 1",
      );
      const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
      return {
        knowledge: n("select count(*) as n from knowledge"),
        message: n("select count(*) as n from message where indexed = 1"),
      };
    }),
  );
  say(
    `Rebuilt the index: ${plural(counts.knowledge, "knowledge row")}, ${plural(counts.message, "message")}`,
  );
}

const oneLine = (s: string) => plain(s).replace(/\n/g, " ");

type Draft = Record<string, { terms?: unknown; content_hash?: unknown }>;
/** The project a terms command works on: key to look it up, name to show */
type Named = { key: string; name: string };

/** The terms commands need the knowledge_terms table, which revision 4 added */
function projectFor(raw: DatabaseSync, place: Named): number {
  const got = versionOf(raw);
  if (got < SCHEMA_REVISION)
    throw new Error(
      `The database is at revision ${got}, older than this Sphica (${SCHEMA_REVISION}). Run \`sphica db migrate\` first`,
    );
  const project = raw.prepare("select id from project where key = ?").get(place.key) as
    | { id: number }
    | undefined;
  if (!project)
    throw new Error(`${place.name} is not registered with Sphica. Register it with \`sphica project add\``);
  return project.id;
}

/**
 * Imports search words for existing records once, from a draft the owner reviewed: `{ "<source_key>": { "terms": "a, b", "content_hash": "<hex>" } }`.
 * Only records of this project whose text is unchanged since the draft (same hash) are written; the rest are listed with the reason.
 */
export function importTerms(
  draft: string,
  place: Named,
  file: string = dbFile(),
): { written: number; unchanged: number; skipped: { key: string; why: string }[] } {
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(draft, "utf8"));
  } catch (e) {
    throw new Error(`Could not read the draft ${draft}: ${e instanceof Error ? e.message : e}`);
  }
  if (typeof entries !== "object" || entries === null || Array.isArray(entries))
    throw new Error(`Could not read the draft ${draft}: it is not a JSON object of source keys`);
  const result = withOwner(file, (raw) =>
    immediate(raw, () => {
      const project = projectFor(raw, place);
      const find = raw.prepare(
        "select id, content_hash from knowledge where project_id = ? and source_key = ?",
      );
      const put = raw.prepare(
        `insert into knowledge_terms (knowledge_id, terms, content_hash, source, written_at) values (?, ?, ?, 'import', ?)
         on conflict (knowledge_id) do update set terms = excluded.terms, content_hash = excluded.content_hash,
           source = excluded.source, written_at = excluded.written_at
         where terms is not excluded.terms or content_hash is not excluded.content_hash or source is not excluded.source`,
      );
      const now = new Date().toISOString();
      let written = 0;
      // The same words already stored for the same text: kept as they are (a rewrite would also churn the index row)
      let unchanged = 0;
      const skipped: { key: string; why: string }[] = [];
      for (const [key, e] of Object.entries(entries as Draft)) {
        const row = find.get(project, key) as { id: number; content_hash: Uint8Array } | undefined;
        if (!row) {
          skipped.push({ key, why: "not a record of this project" });
          continue;
        }
        if (typeof e?.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(e.content_hash)) {
          skipped.push({ key, why: "the draft has no content_hash of 64 hex digits" });
          continue;
        }
        if (Buffer.from(row.content_hash).toString("hex") !== e.content_hash) {
          skipped.push({ key, why: "the record changed after the draft" });
          continue;
        }
        let terms: string;
        try {
          terms = searchTerms(typeof e.terms === "string" ? e.terms : "");
        } catch (x) {
          skipped.push({ key, why: x instanceof Error ? x.message : String(x) });
          continue;
        }
        if (!terms) {
          skipped.push({ key, why: "no terms" });
          continue;
        }
        if (Number(put.run(row.id, terms, row.content_hash, now).changes) > 0) written++;
        else unchanged++;
      }
      return { written, unchanged, skipped };
    }),
  );
  // Keys come from the draft file, which is external text
  for (const s of result.skipped) say(`skipped ${oneLine(s.key)}: ${oneLine(s.why)}`);
  // Nothing written is a failure, not an empty success: the draft is for another project or every record changed
  if (result.written === 0 && result.unchanged === 0 && result.skipped.length > 0)
    throw new Error(
      `Imported no search words: every entry in the draft was skipped (${plural(result.skipped.length, "entry", "entries")})`,
    );
  say(
    `Imported search words for ${plural(result.written, "record")}${result.unchanged ? ` (${result.unchanged} already had the same words)` : ""}`,
  );
  return result;
}

type Listed = {
  id: number;
  source_key: string;
  source: string;
  written_at: string;
  terms: string;
  fresh: number;
};

/** The search words of this project's records, for the owner to check (they are never shown in search results or read). */
export function listTerms(place: Named, ref?: string, file: string = dbFile()): Listed[] {
  const id = ref === undefined ? null : Number(/^k:(\d+)$/.exec(ref)?.[1] ?? Number.NaN);
  if (id !== null && !Number.isSafeInteger(id))
    throw new Error(`Could not read --ref ${JSON.stringify(ref)}: use k:<id>`);
  const rows = withOwner(file, (raw) => {
    const project = projectFor(raw, place);
    if (
      id !== null &&
      !raw.prepare("select 1 from knowledge where id = ? and project_id = ?").get(id, project)
    )
      throw new Error(`k:${id} is not a record of ${place.name}`);
    return raw
      .prepare(
        `select k.id, k.source_key, t.source, t.written_at, t.terms, t.content_hash = k.content_hash as fresh
         from knowledge_terms t join knowledge k on k.id = t.knowledge_id
         where k.project_id = ? and (? is null or k.id = ?) order by k.id`,
      )
      .all(project, id, id) as Listed[];
  });
  for (const r of rows)
    say(
      `k:${r.id} ${oneLine(r.source_key)} (${r.source}, written ${r.written_at.slice(0, 10)}${r.fresh ? "" : ", stale: the record changed"})\n  ${r.terms}`,
    );
  say(
    id !== null && rows.length === 0
      ? `k:${id} has no search words`
      : `${plural(rows.length, "record")} with search words`,
  );
  return rows;
}

/** Database state for doctor. Everything is read only; no file is modified. */
export type Inspection = {
  revision: number;
  /** Sizes of the database and WAL files (bytes) */
  bytes: number;
  /** integrity-check of the full-text index. The reason text when broken */
  fts: { knowledge: string | null; message: string | null };
};

export function inspect(file: string = dbFile()): Inspection {
  const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  return withOwner(file, (raw) => {
    const check = (table: string): string | null => {
      try {
        raw.exec(`insert into ${table} (${table}, rank) values ('integrity-check', 1)`);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    return {
      revision: versionOf(raw),
      bytes: size(file) + size(`${file}-wal`),
      fts: { knowledge: check("knowledge_fts"), message: check("message_fts") },
    };
  });
}
