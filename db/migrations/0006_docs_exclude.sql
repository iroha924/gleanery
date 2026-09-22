-- docs の同期で取り込まない path。追跡された Markdown が全部「事実を述べた文書」とは限らないので
-- （監査の fixture、穴埋めのテンプレート）、取り込む側が名指しで外す。schema.sql の同名の表と対。
-- grant は明示する。schema.sql の `grant ... on all tables` は実行した時点の表にしか効かない。
create table gleanery.docs_exclude (
  connector_id bigint not null references gleanery.connector (id) on delete cascade,
  kind text not null check (kind in ('file', 'directory')),
  path text not null check (
    path <> '' and path !~ '^/' and path !~ '(^|/)\.\.(/|$)' and path !~ '/$' and path !~ '[[:cntrl:]]'
  ),
  primary key (connector_id, kind, path)
);

grant select on gleanery.docs_exclude to gleanery_reader;
grant select, insert, update, delete on gleanery.docs_exclude to gleanery_ingest;
