-- gleanery: foreign_keys=off
-- Removes requirements / design from source_item's kind CHECK. SQLite cannot alter a CHECK, so the table is rebuilt.
-- Dropping with foreign keys on would delete child rows (conversation, knowledge) by cascade, so the runner turns them off.
-- drop loses the autoincrement maximum, so it is saved and restored (deleted ids are never reused).
create temp table source_item_seq as select seq from sqlite_sequence where name = 'source_item';
create table "source_item_new" (
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
insert into "source_item_new" select * from source_item;
drop table source_item;
alter table "source_item_new" rename to "source_item";
create index source_item_listing on source_item (connector_id, kind, state, source_updated_at desc);
update sqlite_sequence set seq = (select seq from source_item_seq)
  where name = 'source_item' and seq < (select seq from source_item_seq);
insert into sqlite_sequence (name, seq) select 'source_item', seq from source_item_seq
  where not exists (select 1 from sqlite_sequence where name = 'source_item');
drop table source_item_seq;
