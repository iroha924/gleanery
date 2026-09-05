-- Postgres は RLS が無効な表のポリシーを完全に無視する。
-- 本番ではプロジェクト作成時の automatic RLS が有効化しているが、それは移行の外にある
-- イベントトリガなので、この移行だけを当てた環境（新プロジェクト、ブランチ）では再現しない。
do $$
declare t text;
begin
  foreach t in array array[
    'scope','scope_group','group_member','record','node','failure_sig',
    'ref','ref_link','relation','conflict','term','asset'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- 表の所有者は既定で RLS を迂回する。所有者で繋ぐ経路が増えたときに素通りしないよう強制する。
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
