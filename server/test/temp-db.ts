// test が使う本物の SQLite。一時ディレクトリに作り、db/schema.sql を当てる。**~/.gleanery を触らない。**
// 役割ごとの接続（reader・ingest・capture）は本番と同じ factory で開くので、authorizer も本番と同じに効く。

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
  /** authorizer を掛けない接続。fixture を入れるときと、権限の外から確かめるときに使う */
  owner: DatabaseSync;
  done: () => Promise<void>;
};

export function tempDb(): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-db-"));
  const file = path.join(dir, "gleanery.db");
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

/** fixture の時刻。schema の CHECK が求める形（ISO 8601 の UTC、ミリ秒まで）。 */
export const at = (s: string): string => new Date(s).toISOString();

/** fixture の hash（32 バイト）。 */
export const hash = (n = 0): Buffer => Buffer.alloc(32, n);

/** プロジェクトを 1 つ入れて id を返す。 */
export function project(db: TempDb, key = "git:github.com/o/r", name = "o/r"): number {
  return Number(
    db.owner.prepare("insert into project (key, name) values (?, ?) returning id").get(key, name)?.id,
  );
}

type Values = Record<string, string | number | Buffer | null>;

/** 1 行入れて rowid を返す。**owner の接続で書く**（語切りの関数があり、FTS の trigger も本番と同じに動く）。 */
export function insert(db: TempDb, table: string, v: Values): number {
  const cols = Object.keys(v);
  const r = db.owner
    .prepare(
      `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")}) returning rowid as rowid`,
    )
    .get(...Object.values(v));
  return Number(r?.rowid);
}

/** trace の知識を 1 件入れる。会話が無ければ作る。 */
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

/** 文書の節を 1 件入れる。docs の connector と source_item も作る。 */
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

/** coding session の発言を 1 件入れて id を返す。 */
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
