---
name: knowledge-schema
description: Changes Sphica's DB schema (db/schema.sql and db/migrations, SQLite), connection roles and authorizers, the full-text search index (FTS5), knowledge kinds and statuses, and how ingestion sources write. Use when touching tables, columns, CHECKs, views, triggers, permissions, or a new import path, and when applying a migration to an existing DB.
---

# Change the knowledge schema

## Triggers

- Changing tables, columns, CHECKs, indexes, views, or triggers in `db/schema.sql`
- Adding a step to `db/migrations`, or applying `sphica db migrate` to an existing DB
- Changing connection roles (the authorizers in `server/src/sqlite.ts` and `server/src/db-write.ts`)
- Changing the full-text search index (FTS5, `sphica_terms`, `terms()` in `server/src/text.ts`)
- Changing `knowledge` kinds, statuses, or stance, `message` speakers, `conversation` origins, or `message_file` actions
- Adding an ingestion source, or changing how GitHub sync, docs sync, capture, or trace write

## Does not trigger

- Work that only creates a DB

## Source of truth and versions

The DB is a single `node:sqlite` file (`~/.sphica/sphica.db`). The only source of truth is `db/schema.sql`, which describes only the current shape.
Do not add a Prisma or Drizzle schema as a second source (Drizzle was rejected: it cannot express FTS5 virtual tables and triggers).
`sphica init` creates a new DB by applying schema.sql to a temporary file and renaming it (safe to run any number of times).

The version is kept in `pragma user_version`. Keep `pragma user_version = N` at the end of schema.sql and `SCHEMA_REVISION` in `server/src/sqlite.ts`
at the same number. The reader and ingest connections compare them on open and stop if they differ.
**Only capture does not compare.** If it did, recording would stop entirely between upgrading the DB and upgrading the plugin.
It keeps writing at the old version, and records the DB rejects go to `rejected/`.

`db/migrations/NNNN_<name>.sql` is the step that moves an existing DB from revision N-1 to N; it is not a source of truth.
`sphica db migrate` (`applyMigrations` in `server/src/admin.ts`, owner) applies migrations newer than the DB's version in number order and
raises `user_version` **per transaction**. If it fails midway, the earlier transactions stay, and running it again continues from there.

- Migrations without a declaration are applied together, as one transaction (`begin immediate`) for each run of them
- A migration that drops or rebuilds a table (`ALTER TABLE`, including adding a column) declares `-- sphica: foreign_keys=off` on line 1. In a migration without it, the runner's authorizer rejects drops and ALTER. It runs in its own transaction, with foreign keys turned off outside it,
  checks that `pragma foreign_key_check` is empty before commit, and turns them back on afterwards. **Forget the declaration, and a drop with foreign keys on
  deletes child rows by cascade.** An unknown declaration, or a declaration anywhere but line 1, stops before anything is applied
- Delete rows first, in a migration without the declaration (with foreign keys on, cascade and set null clean up descendants according to their current meaning).
  The rebuilding migration only copies the remaining rows
- When rebuilding an autoincrement table, save the `sqlite_sequence` value and restore it (a drop erases it, and deleted ids get reused)
- Write rebuilt tables in schema.sql as `create table "table_name"` (to match the text of `sqlite_schema.sql` after a rename)
- `pendingMigrations` stops on bad name shapes, duplicates, and gaps. Names starting with `.` are not read

## When changing the schema

1. In the same commit, change both schema.sql (the current shape) and `db/migrations/NNNN_<name>.sql` (the step that moves existing DBs), and
   raise `user_version` and `SCHEMA_REVISION` to NNNN. `server/test/migrate.test.ts` checks that `db/migrations` runs consecutively from 2
   and that the highest matches `SCHEMA_REVISION` and schema.sql's version
2. Regenerate `server/src/db-types.ts` with `bun run codegen` (it applies schema.sql to an in-memory SQLite and generates from that).
   **Do not edit it by hand.** CI's `codegen:check` fails on drift. For columns holding JSON as strings (`refs`, `downsides`, `next`,
   `metadata`), `overrides` in `scripts/codegen.mjs` adds the types. Generated columns (`knowledge.stance`) do not appear in the types, so
   readers type them with `sql<…>`
3. Make every table `strict`, and write `not null` on every primary key (SQLite allows NULL in non-integer primary keys)
4. Give time columns `check (strftime('%Y-%m-%dT%H:%M:%fZ', column) is column)`. Written with `=`, strftime returns NULL for an invalid string
   and the CHECK passes. Writers go through `iso()` in `server/src/db.ts`
5. Do not write `BEGIN` / `COMMIT` / `ROLLBACK` in migrations. The runner wraps them in a transaction. SQLite evaluates CHECKs immediately per row
   (there is no deferred), so before adding a constraint that applies to existing rows, confirm 0 rows violate it
6. Capture at the old version keeps writing to the new schema after `db migrate`. A change that drops or renames columns of capture's 3 views
   goes in a separate migration, after the plugin is upgraded on every PC
7. Do not write down migrations

## How to write SQL

Write application queries with kysely and let it infer result types. Only `sqlite.ts`, `db-write.ts`,
`db.ts`, `admin.ts`, and the adapter (`kysely-node-sqlite.ts`) may use node:sqlite directly; `bun run sql` fails on `node:sqlite`
imports and connection function calls in other files. Name variables holding a node:sqlite connection `raw` (the SQL ledger counts `raw.exec(` /
`raw.prepare(`).

| Shape | How to write it |
|---|---|
| Nesting a list of children in one row | `jsonArrayFrom` / `jsonObjectFrom` from `kysely/helpers/sqlite`. Add the column names to `JSON_COLUMNS` in `db.ts` (otherwise they come back as strings) |
| JSON column values | On read, `ParseJSONResultsPlugin` turns only the `JSON_COLUMNS` columns back into values. **Narrow it by name** (the default check turns even body text starting with `[` or `{` into arrays). On write, pass `JSON.stringify` output |
| Word search | Join the FTS5 table as a subquery in a `sql` template (`knowledgeFts` in `search.ts`). Build the query with `ftsQuery` in `text.ts` |
| Times | Strings (ISO 8601, UTC, to the millisecond). Lexical order is time order. Convert with `new Date()` at the boundary to the CLI and MCP |
| Booleans | `integer` 0/1. node:sqlite cannot bind booleans |
| BLOBs | Come back as Buffer on read (the adapter converts from Uint8Array). Compare `content_hash` with `.equals` |
| Matching against an array | kysely's `in` is fine (SQLite accepts an empty `in ()`) |
| Writing many rows | Run `insertInto().values([...])` in batches (hundreds of rows). One statement allows up to 32,766 variables |
| Upserts | `onConflict(...).doUpdateSet(...)`. To write only changed rows, `.where("table.content_hash", "<>", eb.ref("excluded.content_hash"))` |

Open write transactions with `inTransaction` in `db.ts` (`begin immediate`). The default `begin` starts as a read, and when it upgrades to a write
and meets another writer, it fails with `SQLITE_BUSY` without waiting for `busy_timeout`. kysely's SQLite connection is a single one, so
do not run other queries in parallel inside a transaction. There is no `select ... for update` (`begin immediate` does the same job).

## Table boundaries

| Boundary | Tables | Writers |
|---|---|---|
| Projects and people | `project`, `person`, `person_identity` | CLI (project, who), GitHub sync |
| Current state of ingestion sources | `connector`, `docs_exclude`, `source_item` | GitHub sync, docs sync, CLI (project exclude) |
| Verbatim conversations | `conversation`, `message`, `message_file` | Capture (capture's 3 views), GitHub sync |
| Searchable knowledge | `knowledge`, `knowledge_file` | trace, docs sync, GitHub sync (lines of the "Decisions" section in the owner's merged PRs; it also reads the old Japanese heading of that section. `server/src/decisions.ts`) |
| Where work stands | `work_item` | trace |

Do not add tables per use. Knowledge is the single `knowledge` table: its kind is `kind`, and whether it is a path not to take is
the generated column `stance` (`do` / `dont` / `neutral`). Do not let an LLM guess the stance.
Do not mix conversations into decision search (knowledge / avoid). Mixed in, work logs push decisions out.

Delete the rows of ingestion-source items confirmed gone by a complete listing. Do not keep `deleted_at` or tombstones.
Do not delete overturned decisions: set `status = 'superseded'` and point to the successor with `superseded_by_id` (deleted ones get proposed again).

## Full-text search index

Search is ranked word search (FTS5's bm25). The calling AI makes up for semantic closeness by searching again with different words (agentic search).

- `knowledge_fts` (rowid = `knowledge.id`; columns are the heading `h`, body plus reason `b`, and extra search words `e`; `bm25(knowledge_fts, 3, 1, 1)`) and
  `message_fts` (rowid = `message.seq`; only messages with `indexed = 1`). Both are contentless (`contentless_delete=1`)
- What `knowledge_fts` holds for a record comes from the view `knowledge_search_text`. The knowledge and knowledge_terms triggers and `db reindex`
  all insert from it, so change the rule there only
- `knowledge_terms` holds extra search words per record (synonyms, abbreviations, English equivalents). **They are search only**: no search result,
  read, or CLI output selects them. They carry the record's `content_hash` from when they were written and are indexed only while
  it still matches (a record whose text changed stops being found by words written for its old text). Writers: trace (`terms` on an item; a decision's
  words go to its options), GitHub sync (a `  - Terms: a, b` line under a PR decision; a blank line clears, no line keeps), and the owner's
  `sphica db terms import`. All go through `searchTerms()` in `server/src/terms.ts`. docs sync writes none (the product generates no text):
  document sections get words only from the owner's import, and a section whose text changed needs a new draft and import
- `terms()` in `server/src/text.ts` splits words. **`sphica_terms`, which the DB triggers call on write, and `ftsQuery`, which builds queries,
  go through the same function.** `db-write.ts` registers `sphica_terms` on each write connection. Writing to knowledge / message from a connection
  without it (such as the `sqlite3` CLI) fails with `no such function` (so the index is never silently incomplete)
- **Change the rules of `terms()`, and the existing index stays old.** A PR that changes them writes `sphica db reindex` into the release steps
- `message.seq` is an explicit `integer primary key` (an implicit rowid can be renumbered by VACUUM)
- Always wrap query words in `"…"` and double any `"` inside (`ftsQuery`). Unwrapped, `AND`, `NEAR`, `:`, and `-` become operators

Measurements live in `server/evals/` (`evals:retrieval` for one-shot search, `evals:agentic` for accuracy when an agent uses it).

## When changing the set of values

The source of truth is the schema's CHECKs; the copies are `KINDS`, `STATUSES`, `SPEAKERS`, `ORIGINS`, and
`FILE_ACTIONS` in `server/src/knowledge.ts`. Add to only one side, and if only the DB has it, search badges come out empty; if only the code has it, ingestion
and capture fail the CHECK. `scripts/check-pairs.mjs` compares the two.

After adding a kind or status, handle these interfaces in the same change.

- The filters in `server/src/search.ts`, and which way the `stance` expression sorts the new value
- The input schema and descriptions in `server/src/mcp.ts` (`kinds` of `recall`)
- The record contract in `plugin/skills/trace/SKILL.md`, and the checks in `server/src/trace.ts`
- If the pair can be listed, add it to `scripts/check-pairs.mjs`

## Connection roles

Processes of the same OS user can rewrite the DB file directly, so this is not an OS permission boundary. What it guards is
the path where Sphica's code writes by mistake, or because untrusted text talked it into it.

| Role | How it opens | Authorizer | Interfaces using it |
|---|---|---|---|
| owner | Writable | None | `sphica db *` and the database check in `doctor` (`admin.ts`) |
| reader | `readOnly` | Only reads and allowed functions. Rejects DDL, ATTACH, and pragmas | MCP, the CLI's listings (`project list`, `who`, the projects in `doctor`) |
| ingest | Writable | Rejects DDL, ATTACH, creating virtual tables, and pragmas that write | `harvest`, `trace save`, `who`, `project` |
| capture | Writable | Only inserts into the 3 views (`capture_*`) and the writes in their triggers. It can read only `project`'s id, key, and name, and `message`'s id | Capture (`capture.ts`) |

- Write connections live only in `server/src/db-write.ts`. `bun run architecture` checks they cannot be reached from the MCP entry
- Enable `enableDefensive(true)` on every connection (it stops direct writes to FTS5's shadow tables). node:sqlite's
  default enables it too, but it is explicit so that a change in the default does not turn it off
- Refer to authorizer actions by their names in `constants`, not by number (there is a record of mixing up `SQLITE_UPDATE` and `SQLITE_DETACH`)
- The initialization order is fixed: open → defensive and pragmas → `sphica_terms` → authorizer. After the authorizer, pragmas get rejected
- Columns not in capture's views (`source_item_id`, `identity_id`, `reply_to_id`, `url`) cannot be claimed. It can neither create GitHub conversations
  nor claim someone else's identity. **Do not count rows by affected rows** (an insert into a view reports 0; count by the difference from the ids present before sending)
- Add to the reader's function allowlist (`READER_FUNCTIONS` in `sqlite.ts`) only when a test fails with `not authorized`
- Do not judge permissions by reading code alone. `server/test/db.test.ts` checks each role's forbidden operations on real connections

## Writes

Do not rewrite rows whose `content_hash` matches (a daily sync does not rewrite every row).

Connect a new ingestion source to `sphica harvest` too. Adding only a manual command does not finish the job.

### Documents

Docs sync (`server/src/docs.ts`) reads the **commit tree** of the remote's default branch. It does not read the working tree.
It keeps the commit it took in `connector.head_oid`, and takes only commits that fast-forward from it automatically.
If it is not a fast-forward, it fetches once more; if the branch has moved past the previously taken commit (another sync running at the same time took it first),
it ends without writing. If not, it treats it as a rewind or force-push, stops without writing, and points to `sphica harvest --cwd <dir> --reset-docs`.
Do not treat a rewind as success: when a leaked document is removed by rewinding, it would silently stay in search.
When changing the projection rules (how sections are split, what context is prepended), raise the `PROJECTION` constant. The next sync rewrites every document.

- Put `path`s not to ingest in `docs_exclude` (tied to the docs connector), applied before blobs are read. Not all tracked
  Markdown is a document stating facts (audit fixtures, if ingested, would return made-up conventions above the real ones)
- Do not ingest `.sphica/` (nested ones included). It used to hold requirements and design docs, and unapproved drafts may remain
- The original text is in `source_item` (`kind` is `document`, the text in `body`); what gets searched is the `document` sections in `knowledge`.
  Joining the sections does not give back the original

### GitHub

GitHub sync (`server/src/github.ts`) fetches everything each time with `gh api`. It keeps the time it started fetching in `connector.snapshot_at`,
and a fetch started before that does not write even if it commits late.
`source_item.closed_at` is the merge time for a PR (the close time if it closed without merging) and the close time for an issue;
a CHECK enforces that `state = 'open'` matches `closed_at is null`.

## Verification

Tests run SQL on a real SQLite database in a temporary directory (`server/test/temp-db.ts`) and look at the results. Do not touch `~/.sphica`.

- `bun run verify` includes:
  - `sql:reach`: counts with V8 coverage whether each SQL call site in `server/src` (except `LIVE_FILES`) ran against a real SQLite inside tests.
    It lists the sites that did not run, by file:line
  - `sql:live`: runs the CLI and the capture hooks as child processes against a DB in a temporary HOME (every call site in `LIVE_FILES`)
- `bun run codegen:check`: whether `db-types.ts` matches schema.sql
- After adding a migration, confirm that `sqlite_schema` matches between a `sphica init` on an empty DB and a `db migrate` from the previous version (`server/test/migration-artifacts.test.ts` applies it from a fixture of the previous schema)

## Applying to an existing DB

Each PC has its own DB. **You apply to your own PC's DB only; it does not reach other PCs.** Apply on each PC.

When the DB is old and an MCP reply points to `db migrate`, the AI does not read that and apply it. The owner runs it in a terminal.

1. Merge
2. Take a backup. Stop MCP and capture, then copy `~/.sphica/sphica.db` (and `-wal` and `-shm`). If applying causes a problem,
   this is the only way back; **apply without it, and there is no way back**
3. The owner runs `sphica db migrate` in a terminal, checks the list to apply, and answers yes
4. Update the plugin (`plugin-release`)
5. Check with `sphica doctor`

To roll back, replace the DB with the backup from step 2. Capture and trace written after the backup are lost. Roll the code back to the same commit too.
