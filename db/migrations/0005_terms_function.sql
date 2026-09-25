-- Recreates the triggers and the view that call the tokenizer function, so they call sphica_terms. The index keeps its rows
-- (the tokenizer is unchanged), and the old function need not be registered: dropping a trigger or view does not call it.
drop trigger message_fts_ai;
drop trigger message_fts_au;
drop view knowledge_search_text;

create trigger message_fts_ai after insert on message when new.indexed = 1 begin
  insert into message_fts (rowid, lexemes) values (new.seq, sphica_terms(new.body));
end;
create trigger message_fts_au after update of body, indexed on message begin
  delete from message_fts where rowid = old.seq and old.indexed = 1;
  insert into message_fts (rowid, lexemes) select new.seq, sphica_terms(new.body) where new.indexed = 1;
end;
create view knowledge_search_text as
select k.id,
  sphica_terms(coalesce(k.heading, '')) as h,
  sphica_terms(k.body || char(10) || coalesce(k.reason, '')) as b,
  sphica_terms(coalesce(t.terms, '')) as e
from knowledge k
left join knowledge_terms t on t.knowledge_id = k.id and t.content_hash = k.content_hash;
