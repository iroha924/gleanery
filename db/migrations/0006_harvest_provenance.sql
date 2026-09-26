-- Prepares removing the bulk import (GitHub sync, docs sync, PR-body extraction) and the people directory.
-- Decisions extracted from the owner's merged PR bodies are kept: they get a pull_request row as their provenance (0007 attaches them),
-- because trace verifications and supersessions may point at them. Document sections and GitHub conversations are deleted here, with
-- foreign keys on, so their messages, files, and terms go by cascade. 0007 rebuilds the tables without the removed columns.

-- Stop before deleting anything if a record outside the removed import points at a document section (trace can only point at decisions,
-- so this should be empty). A row that fails the CHECK aborts the migration.
create temp table guard (what text not null, n integer not null check (n = 0));
insert into guard
select 'records pointing at document sections', count(*)
from knowledge k join knowledge d on d.id in (k.decision_id, k.superseded_by_id)
where d.kind = 'document' and k.kind <> 'document';
insert into guard
select 'pull requests with a number that is not a positive integer', count(*)
from source_item s
where s.kind = 'pull_request'
  and exists (select 1 from knowledge k where k.source_item_id = s.id)
  and (cast(s.external_id as integer) <= 0 or cast(cast(s.external_id as integer) as text) <> s.external_id);
drop table guard;

create table pull_request (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  number integer not null check (number > 0),
  github_id integer check (github_id > 0),
  title text not null check (title <> ''),
  url text,
  state text not null check (state in ('open', 'merged', 'closed')),
  harvested_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', harvested_at) is harvested_at),
  unique (project_id, number)
) strict;

insert into pull_request (project_id, number, title, url, state)
select c.project_id, cast(s.external_id as integer), s.title, s.url, s.state
from source_item s join connector c on c.id = s.connector_id
where s.kind = 'pull_request'
  and exists (select 1 from knowledge k where k.source_item_id = s.id and k.kind <> 'document');

-- The moved decisions no longer belong to the GitHub conversation, which is deleted below (their provenance is the pull request)
update knowledge set conversation_id = null where source_item_id is not null and kind <> 'document';
-- Their search words came from the PR body, not from the harvest Skill
update knowledge_terms set source = 'import' where source = 'pr';

delete from knowledge where kind = 'document';
delete from conversation where origin = 'github';
