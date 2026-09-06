-- 用語集。**AI が聞いて、人が答えて、覚える。**
--
-- 「AA案件移行」「ダブルライト」「ハニカム」は記録に何度も出てくるのに、どこにも定義が無い。
-- 実測: チャットは「定義はこの記録にありません」と正直に答えるが、答えられたほうが価値がある。
--
-- **推測で埋めない。**社内でしか決まっていない語なので、機械が当てると
-- 間違った対応が事実として引かれる（名簿で推測した 3 人と同じ問題）。
-- 代わりに `meaning is null` の行を「まだ聞いていない語」の待ち行列にする。
-- AI が答えられなかった語をそこへ積み、人が答えたら埋まる。
--
-- 元の term は scope（リポジトリ）単位だったが、用語はプロジェクト単位のもの。
-- 「ダブルライト」は main-repo にも dbt にも出てくる。0 行だったので作り直す。
drop table if exists public.term;

create table public.term (
  id         bigint generated always as identity primary key,
  -- null は全プロジェクト共通。ふつうはプロジェクトに属する
  group_id   bigint references public.scope_group(id) on delete cascade,
  word       text not null,
  -- 表記ゆれ。「AA案件」「AA 案件移行」を同じものとして引くため
  aliases    text[] not null default '{}',
  -- **null は「まだ聞いていない」。**これが待ち行列になる
  meaning    text,
  -- AI がこの語を知りたがった文脈。人が答えるときの手がかり
  asked_why  text,
  asked_at   timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- group_id が null の行も含めて一意にする（coalesce で 0 に寄せる）
create unique index term_word on public.term (coalesce(group_id, 0), word);
create index term_pending on public.term (asked_at desc) where meaning is null;

alter table public.term enable row level security;
alter table public.term force row level security;

grant select on public.term to knowledge_ro;
grant select, insert, update, delete on public.term to mitos_cfg;
grant usage, select on sequence public.term_id_seq to mitos_cfg;

drop policy if exists term_read_ro on public.term;
create policy term_read_ro on public.term for select to knowledge_ro using (true);
drop policy if exists term_read_cfg on public.term;
create policy term_read_cfg on public.term for select to mitos_cfg using (true);
drop policy if exists term_write_cfg on public.term;
create policy term_write_cfg on public.term for insert to mitos_cfg with check (true);
drop policy if exists term_update_cfg on public.term;
create policy term_update_cfg on public.term for update to mitos_cfg using (true) with check (true);
drop policy if exists term_delete_cfg on public.term;
create policy term_delete_cfg on public.term for delete to mitos_cfg using (true);
