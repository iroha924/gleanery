-- Supabase の組み込みロールを落とす。
--
-- **移設のときは忠実に復元するために作った。**`pg_dump` が `anon` / `authenticated` /
-- `service_role` への GRANT とポリシーを含むので、受け皿が無いと restore が落ちる。
-- 復元して件数が一致することを確かめる目的だったので、掃除はここで別に行う。
--
-- これらは Supabase の PostgREST と Auth のためのロールで、mitos は 1 つも使っていない。
-- 接続するのは `mitos_admin`（書き込み）/ `knowledge_ro`（MCP・フック・画面の読み取り）/
-- `mitos_cfg`（画面の設定）の 3 つだけである。
--
-- 実測（2026-09-08）: ポリシー 11 本・表の権限 357 件がこの 3 ロールに紐づいていた。
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and roles::text ~ '(anon|authenticated|service_role)'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from anon, authenticated, service_role;
revoke all on schema public, extensions from anon, authenticated, service_role;

drop role if exists anon;
drop role if exists authenticated;
drop role if exists service_role;
