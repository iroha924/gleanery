-- 絞り込みに使う列
create index node_kind_status  on node (kind, status) where deleted_at is null;
create index node_dont         on node (polarity)     where deleted_at is null and polarity = 'dont';
create index node_scope_at     on node (scope_id, at desc) where deleted_at is null;
create index node_record_at    on node (record_id, at);
create index node_failure      on node (failure_sig)  where failure_sig is not null;

-- ベクトル。**内積を使う**。Voyage の埋め込みは正規化済みなので、
-- cosine にすると正規化の計算を無駄に払う（**世に出ているサンプルの多くは cosine で書かれている**ので、
-- そのまま真似すると気付かずに払う）。
create index node_embedding on node
  using hnsw (embedding extensions.vector_ip_ops);
create index record_embedding on record
  using hnsw (embedding extensions.vector_ip_ops);
create index asset_embedding on asset
  using hnsw (embedding extensions.vector_ip_ops);

-- 語彙検索の索引は 20260905160815 で張る（拡張を extensions スキーマへ入れた後）。
;
