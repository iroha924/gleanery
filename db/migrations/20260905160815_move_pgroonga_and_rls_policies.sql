-- 語彙検索の索引。**GIN + gin_trgm_ops。**`ilike '%語%'` を索引で解く。
-- 複数列は 1 本にまとめられないので、列ごとに張る。
create index node_text_trgm   on node   using gin (text extensions.gin_trgm_ops);
create index record_title_trgm on record using gin (title extensions.gin_trgm_ops);
create index record_problem_trgm on record using gin (problem extensions.gin_trgm_ops);
create index record_goal_trgm on record using gin (goal extensions.gin_trgm_ops);
create index term_term_trgm   on term   using gin (term extensions.gin_trgm_ops);
create index term_meaning_trgm on term  using gin (meaning extensions.gin_trgm_ops);

-- ポリシー。**1 人運用でも書く。**
-- 読み取りは authenticated だけ。anon には一切出さない。
-- 書き込みのポリシーは作らない = service_role と直接接続からしか通らない。
-- 推論する層（MCP）と資格情報を持つ層（CLI）を分けるため。
do $$
declare t text;
begin
  foreach t in array array[
    'scope','scope_group','group_member','record','node','failure_sig',
    'ref','ref_link','relation','conflict','term','asset'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read_authenticated', t);
  end loop;
end $$;
;
