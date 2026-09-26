-- The source of truth for sphica's database (SQLite, `node:sqlite`). It lets one owner look up decisions and conversations on that machine.
-- **Each machine is independent and shares no records.** One file (~/.sphica/sphica.db) is one database, with no schema qualifiers.
--
-- Three boundaries: the current state of sources (connector / source_item), verbatim conversations (conversation / message),
-- and searchable knowledge (knowledge). Work status (work_item) is state that gets updated, so it has its own table.
--
-- The version is `pragma user_version` at the end. MCP and the CLI compare it with SCHEMA_REVISION in server/src/db.ts
-- when opening, and stop on a mismatch. `sphica init` creates an empty database (server/src/admin.ts).
-- Every table is STRICT (rejects type mismatches). Every primary key says not null (SQLite allows NULL in non-integer primary keys).
-- server/src/sqlite.ts sets journal_mode and foreign_keys per connection (not here).
--
-- Times are ISO 8601 UTC strings (the `Date#toISOString()` form), so lexical order is chronological order.
-- `strftime(...) is column` rejects values not in normal form (`...:00Z` without milliseconds, offsets, dates not on the calendar).
-- Mixed forms break ordering within a second and make date filters miss at the boundaries.

create table project (
  id integer primary key autoincrement not null,
  -- A key from the normalized git remote (`git:github.com/owner/repo`), or a key set per machine for a project without a remote.
  -- Local paths are not stored. Locations differ per machine.
  key text not null unique check (
    (key glob 'git:*' and key not glob '*[ ' || char(9) || '-' || char(13) || ']*' and length(key) > 4)
    or (key glob 'local:[a-z0-9]*' and substr(key, 7) not glob '*[^a-z0-9._-]*')),
  name text not null check (name <> ''),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    check (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is created_at)
) strict;

create table person (
  id integer primary key autoincrement not null,
  display_name text not null unique check (display_name <> ''),
  is_self integer not null default 0 check (is_self in (0, 1))
) strict;
-- Exactly one person is the owner who asks. This decides who "I" is in "what did I say?".
create unique index person_one_self on person (is_self) where is_self = 1;

-- Identifiers at a source. A GitHub user id stays the same when the login changes, so it goes in external_id.
create table person_identity (
  id integer primary key autoincrement not null,
  person_id integer references person (id) on delete set null,
  provider text not null check (provider in ('github')),
  external_id text not null,
  handle text not null,
  unique (provider, external_id)
) strict;
create index person_identity_handle on person_identity (provider, lower(handle));

-- Per source, the last imported version and the latest result. No secrets (they live in the syncing machine's environment).
-- For documents, the imported commit (head_oid). The next sync imports automatically only commits that fast-forward from it.
-- For GitHub, the time the fetch started (snapshot_at). A fetch that started earlier is not written, even if it commits later.
create table connector (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  provider text not null check (provider in ('github', 'docs')),
  head_oid text check (head_oid is null or (provider = 'docs'
    and (length(head_oid) = 40 or length(head_oid) = 64) and head_oid not glob '*[^0-9a-f]*')),
  snapshot_at text check (snapshot_at is null or provider = 'github')
    check (strftime('%Y-%m-%dT%H:%M:%fZ', snapshot_at) is snapshot_at),
  last_success_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) is last_success_at),
  last_error text,
  unique (project_id, provider)
) strict;

-- Paths the docs sync does not import. Not every tracked Markdown file states facts (such as audit fixtures).
-- **This is importer-side configuration.** It must work for read-only projects too, so it is not a manifest in the repository.
-- file matches the path exactly, and directory matches paths starting with `<path>/`. Only created for the docs connector.
create table docs_exclude (
  connector_id integer not null references connector (id) on delete cascade,
  kind text not null check (kind in ('file', 'directory')),
  path text not null check (
    path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..' and path not glob '*/'
    and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*'),
  primary key (connector_id, kind, path)
) strict;

-- The current state of a source. Items confirmed gone by a complete listing are deleted with their rows (no tombstones).
-- Documents keep their original text in body. Search uses the knowledge sections, and joining sections never restores the original.
create table "source_item" (
  id integer primary key autoincrement not null,
  connector_id integer not null references connector (id) on delete cascade,
  external_id text not null,
  kind text not null check (kind in ('pull_request', 'issue', 'document')),
  title text not null check (title <> ''),
  state text,
  url text,
  path text check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..'),
  body text,
  author_identity_id integer references person_identity (id) on delete set null,
  source_created_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', source_created_at) is source_created_at),
  source_updated_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at) is source_updated_at),
  -- For a PR, the merge time (or the close time if closed without merging); for an issue, the close time. null for open items and documents.
  closed_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) is closed_at),
  content_hash blob not null check (length(content_hash) = 32),
  metadata text not null default '{}' check (json_valid(metadata) and json_type(metadata) = 'object'),
  synced_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    check (strftime('%Y-%m-%dT%H:%M:%fZ', synced_at) is synced_at),
  unique (connector_id, external_id),
  check (
    case
      when kind = 'document' then path is not null and body is not null and state is null
        and closed_at is null
      else path is null and body is null and state in ('open', 'merged', 'closed') and (state = 'open') = (closed_at is null)
    end
  ),
  -- With a NULL state the CHECK above evaluates to NULL and passes, and the pairing with closed_at is not enforced either.
  constraint source_item_state_required check (kind = 'document' or state is not null)
) strict;
create index source_item_listing on source_item (connector_id, kind, state, source_updated_at desc);

-- A conversation: one coding session, or one GitHub PR or issue.
-- The id is a uuid derived deterministically from (project, origin, external_id). Sending the same session twice adds no rows.
create table conversation (
  id text primary key not null,
  project_id integer not null references project (id) on delete cascade,
  source_item_id integer references source_item (id) on delete cascade,
  origin text not null check (origin in ('claude-code', 'codex', 'github')),
  external_id text not null,
  branch text,
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  unique (project_id, origin, external_id),
  check ((origin = 'github') = (source_item_id is not null))
) strict;
create index conversation_recent on conversation (project_id, started_at desc);

-- One row per message. self is what the owner typed, assistant is the AI's last reply or an AI reviewer, and bot is an automated notice.
-- Oversized messages keep only their start and end, with truncated and the original size (UTF-8 bytes).
create table message (
  -- seq is the FTS5 rowid. It is an explicit integer primary key rather than the implicit rowid, so VACUUM does not renumber it
  seq integer primary key not null,
  id text not null unique,
  conversation_id text not null references conversation (id) on delete cascade,
  external_id text not null,
  turn_id text,
  reply_to_id text references message (id) on delete set null,
  speaker_kind text not null check (speaker_kind in ('self', 'person', 'assistant', 'bot')),
  identity_id integer references person_identity (id) on delete set null,
  body text not null check (body <> ''),
  truncated integer not null default 0 check (truncated in (0, 1)),
  original_bytes integer not null check (original_bytes > 0),
  url text,
  sent_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) is sent_at),
  content_hash blob not null check (length(content_hash) = 32),
  -- Whether it goes into the full-text index. 0 for AI replies in coding sessions and automated notices (decided by indexesMessage in capture.ts / github.ts)
  indexed integer not null check (indexed in (0, 1)),
  unique (conversation_id, external_id),
  check (truncated = 1 or original_bytes = length(cast(body as blob))),
  check (truncated = 0 or original_bytes > length(cast(body as blob)))
) strict;
create index message_order on message (conversation_id, sent_at);
create index message_by_identity on message (identity_id, sent_at desc) where identity_id is not null;
create index message_self on message (sent_at desc) where speaker_kind = 'self';

-- The full-text index. rowid = message.seq. Terms are split by sphica_terms() (terms() in server/src/text.ts, registered per connection).
-- Writes from a connection without the function fail with no such function (the index never silently misses rows).
create virtual table message_fts using fts5(lexemes, content='', contentless_delete=1);
create trigger message_fts_ai after insert on message when new.indexed = 1 begin
  insert into message_fts (rowid, lexemes) values (new.seq, sphica_terms(new.body));
end;
create trigger message_fts_ad after delete on message when old.indexed = 1 begin
  delete from message_fts where rowid = old.seq;
end;
create trigger message_fts_au after update of body, indexed on message begin
  delete from message_fts where rowid = old.seq and old.indexed = 1;
  insert into message_fts (rowid, lexemes) select new.seq, sphica_terms(new.body) where new.indexed = 1;
end;

-- Files linked to messages. Capture links an edited file (edit) to the owner's last message before the edit.
-- The GitHub sync links a file pointed to in a review (review) to that review message.
-- read records requirements and design documents read in the past, and is no longer written. path is relative to the project root.
create table message_file (
  message_id text not null references message (id) on delete cascade,
  path text not null check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..'),
  action text not null check (action in ('edit', 'read', 'review')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  primary key (message_id, path, action)
) strict;
create index message_file_path on message_file (path);

-- Work status, updated by trace. active / blocked / paused are candidates for continuing work.
create table work_item (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  source_key text not null,
  title text not null check (title <> ''),
  goal text not null check (goal <> ''),
  current text not null check (current <> ''),
  next text not null default '[]' check (json_valid(next) and json_type(next) = 'array'),
  status text not null check (status in ('active', 'blocked', 'paused', 'done', 'abandoned')),
  conversation_id text references conversation (id) on delete set null,
  updated_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is updated_at),
  unique (project_id, source_key)
) strict;
create index work_item_open on work_item (project_id, updated_at desc) where status in ('active', 'blocked', 'paused');

-- A unit of searchable knowledge: decisions trace picked from conversations, and document sections.
-- Overturned decisions are not deleted (deleting them gets them proposed again). They become superseded and point to the successor.
-- stance follows from kind and status, and filters searches for paths not to take.
create table knowledge (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  source_item_id integer references source_item (id) on delete cascade,
  conversation_id text references conversation (id) on delete cascade,
  work_item_id integer references work_item (id) on delete set null,
  source_key text not null,
  kind text not null check (kind in ('decision', 'option', 'constraint', 'non_goal', 'dead_end', 'finding', 'debt',
                                     'verification', 'question', 'document')),
  status text,
  stance text not null generated always as (
    case
      when kind in ('constraint', 'non_goal', 'debt') then (case status when 'active' then 'dont' else 'neutral' end)
      when kind = 'dead_end' then 'dont'
      when kind = 'option' then (case status when 'chosen' then 'do' else 'dont' end)
      when kind = 'decision' then (case status when 'accepted' then 'do' when 'proposed' then 'neutral' else 'dont' end)
      when kind = 'verification' then (case status when 'failed' then 'dont' else 'neutral' end)
      else 'neutral'
    end
  ) stored,
  confidence text check (confidence in ('fact', 'inference', 'opinion')),
  decision_id integer references knowledge (id) on delete cascade,
  superseded_by_id integer references knowledge (id) on delete set null,
  heading text,
  body text not null check (body <> ''),
  reason text,
  confirmation text,
  command text,
  downsides text not null default '[]' check (json_valid(downsides) and json_type(downsides) = 'array'),
  refs text not null default '[]' check (json_valid(refs) and json_type(refs) = 'array'),
  occurred_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) is occurred_at),
  content_hash blob not null check (length(content_hash) = 32),
  unique (project_id, source_key),
  check (source_item_id is not null or conversation_id is not null),
  check (kind <> 'document' or (source_item_id is not null and heading is not null)),
  check (
    case kind
      when 'decision' then status is not null and status in ('proposed', 'accepted', 'rejected', 'superseded')
      when 'option' then status is not null and status in ('chosen', 'rejected', 'was_chosen')
      when 'verification' then status is not null and status in ('passed', 'failed', 'not_run')
      when 'question' then status is not null and status in ('open', 'blocking', 'resolved')
      when 'constraint' then status is not null and status in ('active', 'retired')
      when 'non_goal' then status is not null and status in ('active', 'retired')
      when 'debt' then status is not null and status in ('active', 'retired')
      else status is null
    end
  ),
  check (case kind when 'option' then decision_id is not null when 'verification' then 1 else decision_id is null end),
  check ((kind = 'decision' and status = 'superseded') = (superseded_by_id is not null)),
  check (superseded_by_id is null or superseded_by_id <> id),
  check (confirmation is null or kind = 'decision'),
  check (command is null or kind = 'verification'),
  check (json_array_length(downsides) = 0 or kind = 'decision'),
  check (kind <> 'document' or work_item_id is null)
) strict;
create index knowledge_listing on knowledge (project_id, kind, status, occurred_at desc);
create index knowledge_work on knowledge (work_item_id) where work_item_id is not null;

-- Extra search words for a record (synonyms, abbreviations, English equivalents of its words). **Search only**: no search result, read,
-- or CLI output shows them. content_hash is the record's hash when they were written; they are indexed only while it
-- still matches, so a record whose text changed stops being found by words written for its old text. source says who wrote them.
create table knowledge_terms (
  knowledge_id integer primary key not null references knowledge (id) on delete cascade,
  terms text not null check (terms <> '' and length(terms) <= 400),
  content_hash blob not null check (length(content_hash) = 32),
  source text not null check (source in ('trace', 'pr', 'import')),
  written_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', written_at) is written_at)
) strict;

-- What the knowledge index holds for each record: heading (h), body plus reason (b), and the extra search words whose hash matches (e).
-- The triggers and `sphica db reindex` all insert from here, so the rule lives in one place.
create view knowledge_search_text as
select k.id,
  sphica_terms(coalesce(k.heading, '')) as h,
  sphica_terms(k.body || char(10) || coalesce(k.reason, '')) as b,
  sphica_terms(coalesce(t.terms, '')) as e
from knowledge k
left join knowledge_terms t on t.knowledge_id = k.id and t.content_hash = k.content_hash;

-- The full-text index. rowid = knowledge.id. Search uses bm25(knowledge_fts, 3, 1, 1).
-- Trace headings hold the work title, and document section headings hold the path and heading levels.
create virtual table knowledge_fts using fts5(h, b, e, content='', contentless_delete=1);
create trigger knowledge_fts_ai after insert on knowledge begin
  insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text where id = new.id;
end;
create trigger knowledge_fts_ad after delete on knowledge begin
  delete from knowledge_fts where rowid = old.id;
end;
create trigger knowledge_fts_au after update of heading, body, reason, content_hash on knowledge begin
  delete from knowledge_fts where rowid = old.id;
  insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text where id = new.id;
end;
create trigger knowledge_terms_ai after insert on knowledge_terms begin
  delete from knowledge_fts where rowid = new.knowledge_id;
  insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text where id = new.knowledge_id;
end;
create trigger knowledge_terms_au after update of terms, content_hash on knowledge_terms begin
  delete from knowledge_fts where rowid = new.knowledge_id;
  insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text where id = new.knowledge_id;
end;
create trigger knowledge_terms_ad after delete on knowledge_terms begin
  delete from knowledge_fts where rowid = old.knowledge_id;
  insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text where id = old.knowledge_id;
end;

-- Direct links between decisions and files. applies_to is a constraint shown before editing, and evidence is a file cited as grounds.
create table knowledge_file (
  knowledge_id integer not null references knowledge (id) on delete cascade,
  path text not null check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..'),
  role text not null check (role in ('applies_to', 'evidence')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  primary key (knowledge_id, path, role)
) strict;
create index knowledge_file_path on knowledge_file (path, role);

-- The 3 views capture (the capture connection) can write. The authorizer in server/src/sqlite.ts allows capture only inserts into these views
-- and the writes inside the triggers below. source_item_id, identity_id, reply_to_id, and url are not in the views, so capture
-- can neither create GitHub conversations nor claim someone else's identity. Conversation ids can be computed deterministically, so adding messages
-- to an existing conversation is not blocked (the remaining surface if the capture path is abused).
create view capture_conversation as
  select id, project_id, origin, external_id, branch, started_at from conversation;
create trigger capture_conversation_insert instead of insert on capture_conversation begin
  insert into conversation (id, project_id, origin, external_id, branch, started_at)
  values (new.id, new.project_id, new.origin, new.external_id, new.branch, new.started_at)
  on conflict do nothing;
end;

create view capture_message as
  select id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes, sent_at, content_hash, indexed
  from message;
create trigger capture_message_insert instead of insert on capture_message begin
  insert into message (id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes,
                       sent_at, content_hash, indexed)
  values (new.id, new.conversation_id, new.external_id, new.turn_id, new.speaker_kind, new.body, new.truncated,
          new.original_bytes, new.sent_at, new.content_hash, new.indexed)
  on conflict do nothing;
end;

-- Link to the owner's last message before the edit. If that message is not in this database (such as a session that moved to another project midway), drop it.
create view capture_message_file as select message_id, path, action from message_file;
create trigger capture_message_file_insert instead of insert on capture_message_file begin
  insert into message_file (message_id, path, action)
  select new.message_id, new.path, new.action where exists (select 1 from message where id = new.message_id)
  on conflict do nothing;
end;

pragma user_version = 5;
