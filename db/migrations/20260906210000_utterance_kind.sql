-- 「誰かがこう言った」を置けるようにする。
--
-- これまでの kind は progress-log が書く判断の 6 種だけだった。PR のレビューや
-- 議事録は判断ではなく**発言**で、決定の前段にある。決定へ丸めると
-- 「〇〇さんが PR#17 でこう言った」という出自が消え、いちばん価値のある部分が失われる。
alter table public.node drop constraint if exists node_kind_check;
alter table public.node add constraint node_kind_check check (
  kind = any (array[
    'event','decision','option','question','verification','boundary',
    -- 人が言ったこと。subkind で review / issue / meeting を分ける
    'utterance'
  ])
);

-- 発言者は既に列がある（actor_kind / actor_name）が、誰も書いていなかった。
-- 発言で引くための索引を足す。
create index if not exists node_actor_name on public.node (actor_name) where actor_name is not null;
create index if not exists node_kind_at on public.node (kind, at desc);
