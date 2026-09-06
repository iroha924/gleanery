-- 誰が誰なのかを持つ。
--
-- 記録に載るのはハンドル名（GitHub の login、Linear の表示名）だけで、それが誰なのかは
-- どこにも書かれていない。実測: 「最新の私の PR はどれ」に対して「あなたがどの GitHub
-- ユーザーかは書かれていません」と返り、他人の PR を最新として挙げた。
--
-- **1 人が複数のハンドルを持つ**（GitHub と Linear で別名、表記ゆれ、bot）ので配列で持つ。
-- 呼び名を別に持つのは、質問がハンドル名で来ないから — 人は「◯◯さん」と聞く。
-- 呼び名からハンドルへの展開は検索の直前にやる（記録へ焼き込むと、名簿を直すたびに
-- 全件の埋め込みを取り直すことになる）。
create table if not exists public.person (
  id         bigint generated always as identity primary key,
  display    text not null unique,            -- 呼び名。「◯◯さん」
  handles    text[] not null default '{}',    -- 記録に出てくる名前。{reviewer-a,レビュアー A}
  is_me      boolean not null default false,  -- 質問者本人。1 人だけ
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 「私」が 2 人いると、どちらを指すか決められない。**表の側で 1 人に縛る。**
create unique index if not exists person_only_one_me on public.person ((is_me)) where is_me;
create index if not exists person_handles on public.person using gin (handles);

alter table public.person enable row level security;
alter table public.person force row level security;

-- 読むのは MCP と画面。書くのは画面（構成であって知識ではない）と CLI。
grant select on public.person to knowledge_ro;
grant select, insert, update, delete on public.person to mitos_cfg;
grant usage, select on sequence public.person_id_seq to mitos_cfg;

drop policy if exists person_read_ro on public.person;
create policy person_read_ro on public.person for select to knowledge_ro using (true);
drop policy if exists person_read_cfg on public.person;
create policy person_read_cfg on public.person for select to mitos_cfg using (true);
drop policy if exists person_write_cfg on public.person;
create policy person_write_cfg on public.person for insert to mitos_cfg with check (true);
drop policy if exists person_update_cfg on public.person;
create policy person_update_cfg on public.person for update to mitos_cfg using (true) with check (true);
drop policy if exists person_delete_cfg on public.person;
create policy person_delete_cfg on public.person for delete to mitos_cfg using (true);
