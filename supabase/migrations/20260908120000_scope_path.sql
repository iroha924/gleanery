-- 置き場所はマシンごとに違う。
--
-- **`scope.abs_path` は絶対パスを 1 つしか持てず、登録したときにしか書かれなかった。**
-- `mitos sync` はそのパスが実在するかで取り込むかを決めるので、別のマシン
-- （ユーザー名やディレクトリ構成が違う新しい PC）では**全部を飛ばしたうえで終了コード 0 を返す**。
-- 毎朝 6:00 に、何も取り込まないまま成功したように見えるジョブが走ることになる。
--
-- 同じ問題は 2 台で交互に作業するときにも出る。1 台ぶんしか持てない列を
-- 「最後に使ったマシン」で上書きすると、**使っていない側の取り込みが止まる** —
-- いちばん取りこぼしたくない向きに壊れる。
--
-- ナレッジの識別子（git remote）はマシンをまたいで同じなので、**変わるのはパスだけ**。
-- そこだけをホストごとに持つ。
create table if not exists public.scope_path (
  scope_id bigint not null references public.scope(id) on delete cascade,
  -- os.hostname()。どのマシンから見た置き場所かを表す
  host     text not null,
  abs_path text not null,
  seen_at  timestamptz not null default now(),
  primary key (scope_id, host)
);
create index if not exists scope_path_host on public.scope_path (host);

alter table public.scope_path enable row level security;
alter table public.scope_path force row level security;

grant select on public.scope_path to knowledge_ro;
drop policy if exists scope_path_read_ro on public.scope_path;
create policy scope_path_read_ro on public.scope_path for select to knowledge_ro using (true);

grant select, insert, update, delete on public.scope_path to mitos_cfg;
drop policy if exists scope_path_cfg on public.scope_path;
create policy scope_path_cfg on public.scope_path for all to mitos_cfg using (true) with check (true);

-- 既存の 1 件を捨てない。**どのホストのものかは分からない**ので、
-- ここでは引き継がない。`mitos adopt` がこのマシンで実在するものを拾い直す。
comment on table public.scope_path is 'そのホストでの作業場所の置き場所。scope.abs_path は最初に登録された 1 台ぶんしか持てなかった';
