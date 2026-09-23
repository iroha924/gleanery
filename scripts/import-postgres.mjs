#!/usr/bin/env node
// PostgreSQL の記録を SQLite へ写す。**評価のためだけに使う**（持ち主の決定、2026-09-23: 本番の
// ~/.gleanery/gleanery.db へは移さない）。PR 4 のゲートは PR 1 の基準と同じ記録で測る必要があり、eval の問いの
// 正解は今の記録の source_key にあるので、その記録を一時の SQLite に写して `GLEANERY_DB` で指す。
// 配布物に入れない。PR 5 で消す。
//
//   node scripts/import-postgres.mjs --to <SQLite のファイル>
//
// 接続文字列は ~/.gleanery/env の GLEANERY_DB_URL（owner）から読む。**引数にも log にも出さない。**
// 一時ファイルへ 1 つの transaction で入れ、件数・content_hash・外部キー・語彙索引を照合してから置き換える。

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { root } from "./lib/live-harness.mjs";

const { connectWriter } = await import(path.join(root, "server/src/db-write.ts"));
const { dbFile, SCHEMA_REVISION } = await import(path.join(root, "server/src/db.ts"));
// pg は server の devDependencies にある（この script のためだけ）。
const require = createRequire(path.join(root, "server/package.json"));
// biome-ignore lint/correctness/noUndeclaredDependencies: server/package.json の devDependencies を解決する
const pg = require("pg");

const { to } = parseArgs({ options: { to: { type: "string" } } }).values;
if (!to) throw new Error("書き先の SQLite ファイルを --to で指定する（既定は持たない）");
const dest = path.resolve(to);
// 本番の DB へ書く経路を作らない（持ち主の決定）。
if (dest === path.resolve(dbFile()) || dest === path.join(os.homedir(), ".gleanery", "gleanery.db"))
  throw new Error("本番の ~/.gleanery/gleanery.db へは写さない。評価用の別のファイルを指定する");
if (fs.existsSync(dest)) throw new Error(`${dest} は既にある。消してから打ち直す`);

/** ~/.gleanery/env の owner の接続文字列。値は外へ出さない。 */
function ownerUrl() {
  const file = path.join(os.homedir(), ".gleanery", "env");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const m = text.match(/^\s*(?:export\s+)?GLEANERY_DB_URL\s*=\s*(.*)$/m);
  const url = process.env.GLEANERY_DB_URL || m?.[1]?.replace(/^["']|["']$/g, "").trim();
  if (!url) throw new Error("GLEANERY_DB_URL が ~/.gleanery/env に無い");
  return url;
}

const iso = (d) => (d === null ? null : new Date(d).toISOString());
const num = (x) => (x === null ? null : Number(x));
const bool = (x) => (x ? 1 : 0);
const json = (x) => JSON.stringify(x ?? []);

const client = new pg.Client({ connectionString: ownerUrl() });
await client.connect();
const q = async (text) => (await client.query(text)).rows;

const tmp = `${dest}.${process.pid}.tmp`;
fs.mkdirSync(path.dirname(dest), { recursive: true });
const raw = connectWriter("owner", tmp, true);
const counts = {};
try {
  raw.exec("pragma journal_mode = wal");
  raw.exec(fs.readFileSync(path.join(root, "db/schema.sql"), "utf8"));
  const put = (table, rows) => {
    counts[table] = rows.length;
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    const st = raw.prepare(
      `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`,
    );
    for (const r of rows) st.run(...cols.map((c) => r[c]));
  };

  raw.exec("begin immediate");
  put(
    "project",
    (await q("select * from gleanery.project order by id")).map((r) => ({
      id: num(r.id),
      key: r.key,
      name: r.name,
      created_at: iso(r.created_at),
    })),
  );
  put(
    "person",
    (await q("select * from gleanery.person order by id")).map((r) => ({
      id: num(r.id),
      display_name: r.display_name,
      is_self: bool(r.is_self),
    })),
  );
  put(
    "person_identity",
    (await q("select * from gleanery.person_identity order by id")).map((r) => ({
      id: num(r.id),
      person_id: num(r.person_id),
      provider: r.provider,
      external_id: r.external_id,
      handle: r.handle,
    })),
  );
  put(
    "connector",
    (await q("select * from gleanery.connector order by id")).map((r) => ({
      id: num(r.id),
      project_id: num(r.project_id),
      provider: r.provider,
      head_oid: r.head_oid,
      snapshot_at: iso(r.snapshot_at),
      last_success_at: iso(r.last_success_at),
      last_error: r.last_error,
    })),
  );
  put(
    "docs_exclude",
    (await q("select * from gleanery.docs_exclude order by connector_id, kind, path")).map((r) => ({
      connector_id: num(r.connector_id),
      kind: r.kind,
      path: r.path,
    })),
  );
  put(
    "source_item",
    (await q("select * from gleanery.source_item order by id")).map((r) => ({
      id: num(r.id),
      connector_id: num(r.connector_id),
      external_id: r.external_id,
      kind: r.kind,
      title: r.title,
      state: r.state,
      url: r.url,
      path: r.path,
      body: r.body,
      author_identity_id: num(r.author_identity_id),
      source_created_at: iso(r.source_created_at),
      source_updated_at: iso(r.source_updated_at),
      closed_at: iso(r.closed_at),
      content_hash: r.content_hash,
      metadata: JSON.stringify(r.metadata ?? {}),
      synced_at: iso(r.synced_at),
    })),
  );
  // 題（conversation.title）は写さない（生成しない方針にした列）。
  put(
    "conversation",
    (await q("select * from gleanery.conversation order by id")).map((r) => ({
      id: r.id,
      project_id: num(r.project_id),
      source_item_id: num(r.source_item_id),
      origin: r.origin,
      external_id: r.external_id,
      branch: r.branch,
      started_at: iso(r.started_at),
    })),
  );
  // seq は (sent_at, id) の順に振る。返信の親を先に入れる必要は無い（外部キーは文ごとに確かめられるが、
  // 親を指す行は親より後の時刻にある。同じ時刻で前後する分は、後で書き戻す）。
  const messages = await q(
    "select *, lexemes is not null as indexed_now from gleanery.message order by sent_at, id",
  );
  put(
    "message",
    messages.map((r, i) => ({
      seq: i + 1,
      id: r.id,
      conversation_id: r.conversation_id,
      external_id: r.external_id,
      turn_id: r.turn_id,
      reply_to_id: null,
      speaker_kind: r.speaker_kind,
      identity_id: num(r.identity_id),
      body: r.body,
      truncated: bool(r.truncated),
      original_bytes: r.original_bytes,
      url: r.url,
      sent_at: iso(r.sent_at),
      content_hash: r.content_hash,
      indexed: bool(r.indexed_now),
    })),
  );
  const reply = raw.prepare("update message set reply_to_id = ? where id = ?");
  for (const r of messages) if (r.reply_to_id) reply.run(r.reply_to_id, r.id);
  put(
    "message_file",
    (await q("select * from gleanery.message_file order by message_id, path, action")).map((r) => ({
      message_id: r.message_id,
      path: r.path,
      action: r.action,
      line_start: r.line_start,
      line_end: r.line_end,
    })),
  );
  put(
    "work_item",
    (await q("select * from gleanery.work_item order by id")).map((r) => ({
      id: num(r.id),
      project_id: num(r.project_id),
      source_key: r.source_key,
      title: r.title,
      goal: r.goal,
      current: r.current,
      next: json(r.next),
      status: r.status,
      conversation_id: r.conversation_id,
      updated_at: iso(r.updated_at),
    })),
  );
  // 案は決定の後、覆された決定は後継の後に入れる。SQLite の CHECK は行ごとにすぐ評価されるので、
  // 後継を NULL のまま先に入れて後で埋める形が取れない（superseded は後継を指すことを CHECK が強制する）。
  const knowledge = (await q("select * from gleanery.knowledge order by id")).map((r) => ({
    id: num(r.id),
    project_id: num(r.project_id),
    source_item_id: num(r.source_item_id),
    conversation_id: r.conversation_id,
    work_item_id: num(r.work_item_id),
    source_key: r.source_key,
    kind: r.kind,
    status: r.status,
    confidence: r.confidence,
    decision_id: num(r.decision_id),
    superseded_by_id: num(r.superseded_by_id),
    heading: r.heading,
    body: r.body,
    reason: r.reason,
    confirmation: r.confirmation,
    command: r.command,
    downsides: json(r.downsides),
    refs: json(r.refs),
    occurred_at: iso(r.occurred_at),
    content_hash: r.content_hash,
  }));
  const placed = new Set();
  const ordered = [];
  let rest = knowledge;
  while (rest.length) {
    const ready = rest.filter(
      (k) =>
        (k.decision_id === null || placed.has(k.decision_id)) &&
        (k.superseded_by_id === null || placed.has(k.superseded_by_id)),
    );
    if (ready.length === 0)
      throw new Error(`知識の依存が輪になっている: ${rest.map((k) => k.id).join(", ")}`);
    for (const k of ready) placed.add(k.id);
    ordered.push(...ready);
    rest = rest.filter((k) => !placed.has(k.id));
  }
  put("knowledge", ordered);
  put(
    "knowledge_file",
    (await q("select * from gleanery.knowledge_file order by knowledge_id, path, role")).map((r) => ({
      knowledge_id: num(r.knowledge_id),
      path: r.path,
      role: r.role,
      line_start: r.line_start,
      line_end: r.line_end,
    })),
  );
  raw.exec("commit");

  // ---- 照合 ----
  const problems = [];
  const one = (text) => raw.prepare(text).get();
  for (const table of Object.keys(counts)) {
    const got = one(`select count(*) as n from ${table}`).n;
    const want = Number((await q(`select count(*) as n from gleanery.${table}`))[0].n);
    if (got !== want || got !== counts[table]) problems.push(`${table}: PostgreSQL ${want} / SQLite ${got}`);
  }
  const digest = (rows) => {
    const h = crypto.createHash("sha256");
    for (const r of rows) h.update(`${r.id}\0${Buffer.from(r.content_hash).toString("hex")}\n`);
    return h.digest("hex");
  };
  for (const table of ["source_item", "knowledge"]) {
    const a = digest(raw.prepare(`select id, content_hash from ${table} order by id`).all());
    const b = digest(await q(`select id, content_hash from gleanery.${table} order by id`));
    if (a !== b) problems.push(`${table}: content_hash が一致しない`);
  }
  {
    const a = digest(raw.prepare("select id, content_hash from message order by id").all());
    // PostgreSQL の文字列の並びは照合順序に従う。SQLite のバイト順と揃えるため C で並べる。
    const b = digest(
      await q('select id::text as id, content_hash from gleanery.message order by id::text collate "C"'),
    );
    if (a !== b) problems.push("message: content_hash が一致しない");
  }
  const fk = raw.prepare("pragma foreign_key_check").all();
  if (fk.length) problems.push(`外部キーの壊れた行が ${fk.length} 件`);
  for (const t of ["knowledge_fts", "message_fts"]) {
    try {
      raw.exec(`insert into ${t} (${t}, rank) values ('integrity-check', 1)`);
    } catch (e) {
      problems.push(`${t}: ${e.message}`);
    }
  }
  const ftsK = one("select count(*) as n from knowledge_fts").n;
  const ftsM = one("select count(*) as n from message_fts").n;
  if (ftsK !== counts.knowledge)
    problems.push(`knowledge_fts: ${ftsK} 行（knowledge は ${counts.knowledge}）`);
  const indexed = one("select count(*) as n from message where indexed = 1").n;
  if (ftsM !== indexed) problems.push(`message_fts: ${ftsM} 行（索引する発言は ${indexed}）`);
  if (one("pragma user_version").user_version !== SCHEMA_REVISION) problems.push("user_version が違う");
  if (problems.length) throw new Error(`照合が合わない:\n  ${problems.join("\n  ")}`);
} catch (e) {
  raw.close();
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  await client.end();
  throw e;
}
raw.close();
await client.end();
fs.renameSync(tmp, dest);
for (const f of [`${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
console.log(
  `写した: ${dest}\n  ${Object.entries(counts)
    .map(([t, n]) => `${t} ${n}`)
    .join(" / ")}\n  件数・content_hash・外部キー・語彙索引の照合は一致した`,
);
