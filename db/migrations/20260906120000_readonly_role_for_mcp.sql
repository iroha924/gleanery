-- MCP が持つ鍵を、書けない鍵にする。
--
-- セッションを read only にしても、それは「そのセッションで書かない」だけで、鍵自体は書ける。
-- 推論する層（MCP）と資格情報を持つ層（CLI）を分けるという方針は、鍵が同じままでは
-- 運用でしか担保できない（rules/ai-agent-security.md ルール 2）。
--
-- **パスワードはここに書かない。**移行はリポジトリに入るので、別途 alter role で設定する。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'knowledge_ro') then
    create role knowledge_ro login;
  end if;
end $$;

-- **RLS だけに頼らない。**表の既定の権限に INSERT/UPDATE/DELETE/TRUNCATE が付いたまま、
-- 書き込みを止めているのがポリシーだけ、という状態は作らない。このロールは**権限の側で**読み取りに限る。
revoke all on all tables in schema public from knowledge_ro;
grant usage on schema public, extensions to knowledge_ro;
grant select on all tables in schema public to knowledge_ro;
alter default privileges in schema public grant select on tables to knowledge_ro;

-- RLS は force で有効なので、ポリシーの無いロールは 0 行しか見えない。
-- 既存の select ポリシーは authenticated 向けなので、このロール向けを別に作る。
-- authenticated を継承させないのは、継承すると書き込み権限まで付いてくるため。
do $$
declare t text;
begin
  foreach t in array array[
    'scope','scope_group','group_member','record','node','failure_sig',
    'ref','ref_link','relation','conflict','term','asset'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_read_ro', t);
    execute format('create policy %I on public.%I for select to knowledge_ro using (true)', t || '_read_ro', t);
  end loop;
end $$;
