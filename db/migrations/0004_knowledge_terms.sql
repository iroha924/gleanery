-- gleanery: foreign_keys=off
-- Adds extra search words per record (knowledge_terms) and rebuilds the knowledge index with a third column for them.
create table knowledge_terms (
  knowledge_id integer primary key not null references knowledge (id) on delete cascade,
  terms text not null check (terms <> '' and length(terms) <= 400),
  content_hash blob not null check (length(content_hash) = 32),
  source text not null check (source in ('trace', 'pr', 'import')),
  written_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', written_at) is written_at)
) strict;

create view knowledge_search_text as
select k.id,
  gleanery_terms(coalesce(k.heading, '')) as h,
  gleanery_terms(k.body || char(10) || coalesce(k.reason, '')) as b,
  gleanery_terms(coalesce(t.terms, '')) as e
from knowledge k
left join knowledge_terms t on t.knowledge_id = k.id and t.content_hash = k.content_hash;

drop trigger knowledge_fts_ai;
drop trigger knowledge_fts_ad;
drop trigger knowledge_fts_au;
drop table knowledge_fts;
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
insert into knowledge_fts (rowid, h, b, e) select id, h, b, e from knowledge_search_text;
