// The real SQLite database tests use. Created in a temp directory with db/schema.sql applied. **Never touches ~/.sphica.**
// Role connections (reader, ingest, capture) open through the production factory, so the authorizer works as in production.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { openReader } from "../src/db.ts";
import type { DB } from "../src/db-types.ts";
import { connectWriter, openWriter } from "../src/db-write.ts";

const SCHEMA = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "db", "schema.sql"), "utf8");

export type TempDb = {
  file: string;
  reader: Kysely<DB>;
  ingest: Kysely<DB>;
  capture: Kysely<DB>;
  /** A connection without the authorizer, for inserting fixtures and checking from outside the permissions */
  owner: DatabaseSync;
  done: () => Promise<void>;
};

export function tempDb(): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-db-"));
  const file = path.join(dir, "sphica.db");
  const owner = connectWriter("owner", file, true);
  owner.exec("pragma journal_mode = wal");
  owner.exec(SCHEMA);
  const reader = openReader(file);
  const ingest = openWriter("ingest", file);
  const capture = openWriter("capture", file);
  return {
    file,
    reader,
    ingest,
    capture,
    owner,
    done: async () => {
      await Promise.all([reader.destroy(), ingest.destroy(), capture.destroy()]);
      owner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Fixture time in the form the schema CHECK requires (ISO 8601 UTC with milliseconds). */
export const at = (s: string): string => new Date(s).toISOString();

/** Fixture hash (32 bytes). */
export const hash = (n = 0): Buffer => Buffer.alloc(32, n);

/** Inserts one project and returns its id. */
export function project(db: TempDb, key = "git:github.com/o/r", name = "o/r"): number {
  return Number(
    db.owner.prepare("insert into project (key, name) values (?, ?) returning id").get(key, name)?.id,
  );
}

type Values = Record<string, string | number | Buffer | null>;

/** Inserts one row and returns its rowid. **Writes with the owner connection** (it has the tokenizer function, so FTS triggers run as in production). */
export function insert(db: TempDb, table: string, v: Values): number {
  const cols = Object.keys(v);
  const r = db.owner
    .prepare(
      `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")}) returning rowid as rowid`,
    )
    .get(...Object.values(v));
  return Number(r?.rowid);
}

/** Inserts one trace knowledge record, creating the conversation if needed. */
export function knowledge(
  db: TempDb,
  projectId: number,
  v: Values & { source_key: string; body: string },
): number {
  const conversation = `00000000-0000-8000-8000-${String(projectId).padStart(12, "0")}`;
  db.owner
    .prepare(
      "insert into conversation (id, project_id, origin, external_id, started_at) values (?, ?, 'claude-code', ?, ?) on conflict do nothing",
    )
    .run(conversation, projectId, `trace-${projectId}`, at("2026-09-01T00:00:00Z"));
  return insert(db, "knowledge", {
    project_id: projectId,
    conversation_id: conversation,
    kind: "finding",
    occurred_at: at("2026-09-10T00:00:00Z"),
    content_hash: hash(),
    ...v,
  });
}

/** Inserts one document section, also creating the docs connector and source_item. */
export function documentSection(
  db: TempDb,
  projectId: number,
  v: { path: string; heading: string; body: string; key?: string },
): number {
  db.owner
    .prepare("insert into connector (project_id, provider) values (?, 'docs') on conflict do nothing")
    .run(projectId);
  const connector = Number(
    db.owner.prepare("select id from connector where project_id = ? and provider = 'docs'").get(projectId)
      ?.id,
  );
  db.owner
    .prepare(
      `insert into source_item (connector_id, external_id, kind, title, path, body, content_hash)
       values (?, ?, 'document', ?, ?, ?, ?) on conflict do nothing`,
    )
    .run(connector, v.path, v.path, v.path, v.body, hash());
  const source = Number(
    db.owner
      .prepare("select id from source_item where connector_id = ? and external_id = ?")
      .get(connector, v.path)?.id,
  );
  return insert(db, "knowledge", {
    project_id: projectId,
    source_item_id: source,
    kind: "document",
    source_key: v.key ?? `${v.path}#${v.heading}`,
    heading: v.heading,
    body: v.body,
    occurred_at: at("2026-09-10T00:00:00Z"),
    content_hash: hash(),
  });
}

/** Inserts one coding session message and returns its id. */
export function message(
  db: TempDb,
  projectId: number,
  v: { id: string; body: string; speaker?: string; sent?: string; indexed?: number; session?: string },
): string {
  const session = v.session ?? "s1";
  const conversation = `c-${projectId}-${session}`;
  db.owner
    .prepare(
      "insert into conversation (id, project_id, origin, external_id, started_at) values (?, ?, 'claude-code', ?, ?) on conflict do nothing",
    )
    .run(conversation, projectId, session, at("2026-09-01T00:00:00Z"));
  insert(db, "message", {
    id: v.id,
    conversation_id: conversation,
    external_id: v.id,
    speaker_kind: v.speaker ?? "self",
    body: v.body,
    original_bytes: Buffer.byteLength(v.body),
    sent_at: at(v.sent ?? "2026-09-10T00:00:00Z"),
    content_hash: hash(),
    indexed: v.indexed ?? 1,
  });
  return v.id;
}
