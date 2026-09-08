-- **読む側のいない列を落とす。**観測ログは「何を聞かれて、答えを持っていたか」だけで足りる。
-- 入れた当初は絞り込み条件も返した node id も持っていたが、引く口を 1 つも作らなかった。
-- 必要になったら足す（同じ 1 行の insert に列が増えるだけ）。
alter table public.search_log
  drop column if exists cwd,
  drop column if exists kinds,
  drop column if exists only_rejected,
  drop column if exists all_scopes,
  drop column if exists hits,
  drop column if exists top_score,
  drop column if exists node_ids;

-- relevance で引く索引だけ残る（20260908110000 の search_log_weak）。
