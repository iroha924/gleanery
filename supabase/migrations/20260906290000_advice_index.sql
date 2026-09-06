-- 編集の直前に「そのファイルについて過去に言われたこと」を引くための索引。
--
-- **フックの予算は 2.5 秒。**索引なしで実測 17.5 秒だった（PR の状態を引く join が
-- 毎回 6,000 件超の PR ノードを走査していた）。超えると fail-open で黙るので、
-- 索引が無い＝機能が存在しないのと同じになる。
--
-- 引く形は「record の中で、その PR 番号の PR ノードを 1 件」。
-- attrs は JSONB なので式索引にする。部分索引にしているのは、PR ノードが
-- node 全体の 4 分の 1 しかなく、他の行まで載せると索引が無駄に太るため。
-- **索引を張るのに 2 分では足りない**（node は 26,000 行 × 埋め込み 12KB）。
-- セッション側で上限を外す。
set statement_timeout = '30min';

create index if not exists node_pr_in_record
  on public.node (record_id, (attrs->>'pr'))
  where kind = 'event' and subkind = 'pr';

-- 発言側も、PR 番号で絞れるようにする（同じ PR の連打を畳むときに使う）。
create index if not exists node_utterance_pr
  on public.node ((attrs->>'pr'))
  where kind = 'utterance' and deleted_at is null;
