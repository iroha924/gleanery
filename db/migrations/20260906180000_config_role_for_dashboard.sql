-- 画面から「どのリポジトリを束ねるか」を設定するための鍵。
--
-- 読み取り専用ロールでは書けず、管理ロールを画面へ渡すとナレッジ本体まで書ける。
-- **束ねる設定は構成であって知識ではない**ので、その 2 表だけ書ける鍵を分ける。
-- record / node / ref には触れないので、画面が壊れてもナレッジは書き換わらない。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mitos_cfg') then
    create role mitos_cfg login;
  end if;
end $$;

revoke all on all tables in schema public from mitos_cfg;
grant usage on schema public, extensions to mitos_cfg;
grant select on all tables in schema public to mitos_cfg;
alter default privileges in schema public grant select on tables to mitos_cfg;

-- 作業場所そのものは、未登録のディレクトリを束ねるときに作る必要がある。
grant insert on public.scope to mitos_cfg;
grant update (role, summary, updated_at) on public.scope to mitos_cfg;
grant usage, select on sequence public.scope_id_seq to mitos_cfg;
-- 束は作る・消すの両方が要る
grant insert, delete on public.scope_group, public.group_member to mitos_cfg;
grant usage, select on sequence public.scope_group_id_seq to mitos_cfg;

-- RLS は force なので、ポリシーの無いロールは 0 行しか見えない。
do $$
declare t text;
begin
  foreach t in array array[
    'scope','scope_group','group_member','record','node','failure_sig',
    'ref','ref_link','relation','conflict','term','asset'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_read_cfg', t);
    execute format('create policy %I on public.%I for select to mitos_cfg using (true)', t || '_read_cfg', t);
  end loop;
  foreach t in array array['scope','scope_group','group_member'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write_cfg', t);
    execute format('create policy %I on public.%I for insert to mitos_cfg with check (true)', t || '_write_cfg', t);
  end loop;
  foreach t in array array['scope_group','group_member'] loop
    execute format('drop policy if exists %I on public.%I', t || '_delete_cfg', t);
    execute format('create policy %I on public.%I for delete to mitos_cfg using (true)', t || '_delete_cfg', t);
  end loop;
  execute 'drop policy if exists scope_update_cfg on public.scope';
  execute 'create policy scope_update_cfg on public.scope for update to mitos_cfg using (true) with check (true)';
end $$;
