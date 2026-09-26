-- sphica: foreign_keys=off
-- Rebuilds the tables that held the removed bulk import's columns and values, and drops the removed tables.
-- knowledge keeps its ids (the knowledge_fts rowid, and decision_id / superseded_by_id), and message keeps seq (the message_fts rowid).
-- The decisions 0006 kept move to their pull_request, with keys `pr:<number>#...` (the project already fixes the repository).
-- The runner turns foreign keys off for this file and checks `pragma foreign_key_check` before committing.
create temp table knowledge_seq as select seq from sqlite_sequence where name = 'knowledge';

-- Triggers that read the view go first: a rename re-reads every trigger, and one pointing at a dropped view stops it
drop trigger knowledge_fts_ai;
drop trigger knowledge_fts_ad;
drop trigger knowledge_fts_au;
drop trigger knowledge_terms_ai;
drop trigger knowledge_terms_au;
drop trigger knowledge_terms_ad;
drop view knowledge_search_text;
drop view capture_conversation;
drop view capture_message;
drop view capture_message_file;

create table "conversation_new" (
  id text primary key not null,
  project_id integer not null references project (id) on delete cascade,
  origin text not null check (origin in ('claude-code', 'codex')),
  external_id text not null,
  branch text,
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  unique (project_id, origin, external_id)
) strict;
insert into conversation_new (id, project_id, origin, external_id, branch, started_at)
select id, project_id, origin, external_id, branch, started_at from conversation;
drop table conversation;
alter table conversation_new rename to conversation;

create table "message_new" (
  -- seq is the FTS5 rowid. It is an explicit integer primary key rather than the implicit rowid, so VACUUM does not renumber it
  seq integer primary key not null,
  id text not null unique,
  conversation_id text not null references conversation (id) on delete cascade,
  external_id text not null,
  turn_id text,
  speaker_kind text not null check (speaker_kind in ('self', 'assistant')),
  body text not null check (body <> ''),
  truncated integer not null default 0 check (truncated in (0, 1)),
  original_bytes integer not null check (original_bytes > 0),
  sent_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) is sent_at),
  content_hash blob not null check (length(content_hash) = 32),
  -- Whether it goes into the full-text index. 0 for AI replies (decided by indexesMessage in knowledge.ts)
  indexed integer not null check (indexed in (0, 1)),
  unique (conversation_id, external_id),
  check (truncated = 1 or original_bytes = length(cast(body as blob))),
  check (truncated = 0 or original_bytes > length(cast(body as blob)))
) strict;
insert into message_new (seq, id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes, sent_at,
                         content_hash, indexed)
select seq, id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes, sent_at, content_hash, indexed
from message;
drop table message;
alter table message_new rename to message;

create table "message_file_new" (
  message_id text not null references message (id) on delete cascade,
  path text not null check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..'),
  action text not null check (action in ('edit', 'read')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  primary key (message_id, path, action)
) strict;
insert into message_file_new (message_id, path, action, line_start, line_end)
select message_id, path, action, line_start, line_end from message_file;
drop table message_file;
alter table message_file_new rename to message_file;

create table "knowledge_new" (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  conversation_id text references conversation (id) on delete cascade,
  pull_request_id integer references pull_request (id) on delete cascade,
  work_item_id integer references work_item (id) on delete set null,
  source_key text not null,
  kind text not null check (kind in ('decision', 'option', 'constraint', 'non_goal', 'dead_end', 'finding', 'debt',
                                     'verification', 'question')),
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
  -- Exactly one provenance: the session trace read, or the pull request harvest read
  check ((conversation_id is null) <> (pull_request_id is null)),
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
  check (json_array_length(downsides) = 0 or kind = 'decision')
) strict;
insert into knowledge_new (id, project_id, conversation_id, pull_request_id, work_item_id, source_key, kind, status, confidence,
                           decision_id, superseded_by_id, heading, body, reason, confirmation, command, downsides, refs,
                           occurred_at, content_hash)
select k.id, k.project_id, k.conversation_id, pr.id, k.work_item_id,
  case when pr.id is null then k.source_key else 'pr:' || substr(k.source_key, instr(k.source_key, '/pull/') + 6) end,
  k.kind, k.status, k.confidence, k.decision_id, k.superseded_by_id, k.heading, k.body, k.reason, k.confirmation, k.command,
  k.downsides, k.refs, k.occurred_at, k.content_hash
from knowledge k
left join source_item s on s.id = k.source_item_id
left join connector c on c.id = s.connector_id
left join pull_request pr on pr.project_id = c.project_id and pr.number = cast(s.external_id as integer);
drop table knowledge;
alter table knowledge_new rename to knowledge;
delete from sqlite_sequence where name = 'knowledge';
insert into sqlite_sequence (name, seq) select 'knowledge', seq from knowledge_seq where seq is not null;

create table "knowledge_terms_new" (
  knowledge_id integer primary key not null references knowledge (id) on delete cascade,
  terms text not null check (terms <> '' and length(terms) <= 400),
  content_hash blob not null check (length(content_hash) = 32),
  source text not null check (source in ('trace', 'harvest', 'import')),
  written_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', written_at) is written_at)
) strict;
insert into knowledge_terms_new (knowledge_id, terms, content_hash, source, written_at)
select knowledge_id, terms, content_hash, source, written_at from knowledge_terms;
drop table knowledge_terms;
alter table knowledge_terms_new rename to knowledge_terms;

drop table source_item;
drop table docs_exclude;
drop table connector;
drop table person_identity;
drop table person;

create index conversation_recent on conversation (project_id, started_at desc);
create index message_order on message (conversation_id, sent_at);
create index message_self on message (sent_at desc) where speaker_kind = 'self';
create index message_file_path on message_file (path);
create index knowledge_listing on knowledge (project_id, kind, status, occurred_at desc);
create index knowledge_work on knowledge (work_item_id) where work_item_id is not null;

create view knowledge_search_text as
select k.id,
  sphica_terms(coalesce(k.heading, '')) as h,
  sphica_terms(k.body || char(10) || coalesce(k.reason, '')) as b,
  sphica_terms(coalesce(t.terms, '') || char(10) || k.refs) as e
from knowledge k
left join knowledge_terms t on t.knowledge_id = k.id and t.content_hash = k.content_hash;

create view capture_conversation as
  select id, project_id, origin, external_id, branch, started_at from conversation;

create view capture_message as
  select id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes, sent_at, content_hash, indexed
  from message;

create view capture_message_file as select message_id, path, action from message_file;

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
create trigger capture_conversation_insert instead of insert on capture_conversation begin
  insert into conversation (id, project_id, origin, external_id, branch, started_at)
  values (new.id, new.project_id, new.origin, new.external_id, new.branch, new.started_at)
  on conflict do nothing;
end;
create trigger capture_message_insert instead of insert on capture_message begin
  insert into message (id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes,
                       sent_at, content_hash, indexed)
  values (new.id, new.conversation_id, new.external_id, new.turn_id, new.speaker_kind, new.body, new.truncated,
          new.original_bytes, new.sent_at, new.content_hash, new.indexed)
  on conflict do nothing;
end;
create trigger capture_message_file_insert instead of insert on capture_message_file begin
  insert into message_file (message_id, path, action)
  select new.message_id, new.path, new.action where exists (select 1 from message where id = new.message_id)
  on conflict do nothing;
end;

-- The index text changed (refs are now searchable), so it is filled again from the view
insert into knowledge_fts (knowledge_fts) values ('delete-all');
insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text;
