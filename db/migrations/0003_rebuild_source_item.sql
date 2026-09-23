-- gleanery: foreign_keys=off
-- source_item の kind の CHECK から requirements / design を外す。SQLite は CHECK を変えられないので表を作り直す。
-- 外部キーが効いたまま drop すると、子（conversation・knowledge）の行が cascade で消えるので、runner が切って当てる。
-- autoincrement の最大値は drop で消えるので、控えて戻す（消した id を振り直さない）。
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
  -- PR はマージした時刻（マージせず閉じたなら閉じた時刻）、issue は閉じた時刻。開いているものと文書は null。
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
  -- 上の CHECK は state が NULL だと式全体が NULL になって通る。closed_at との対もそのとき守られない。
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
