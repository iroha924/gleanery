-- issue の出どころを「作業場所」として置けるようにする。
--
-- **課題管理はプロジェクトごとに違う**（GitHub / Linear / Jira）。Linear を使う場合、
-- issue はどのリポジトリにも属さない。node.scope_id は not null なので、いずれかのリポジトリへ
-- 寄せるしかないが、どれを選んでも出自が嘘になる。
--
-- **表を足さずに scope を広げる。**別表にすると node が指せず、検索の経路が二重になる。
-- 束（scope_group）へ足せば、チャットでプロジェクトを選んだときに issue も一緒に引ける。
alter table public.scope drop constraint if exists scope_ident_kind_check;
alter table public.scope add constraint scope_ident_kind_check check (
  ident_kind = any (array['git-remote', 'abs-path', 'tracker'])
);

comment on column public.scope.ident_kind is
  'git-remote / abs-path はディレクトリ。tracker は issue の出どころ（linear:org/team など）で、束に足して使う';
comment on table public.scope is
  '作業場所。ディレクトリか、issue の出どころ。git の有無に依らず成立する';
