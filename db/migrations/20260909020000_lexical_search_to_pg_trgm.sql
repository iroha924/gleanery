-- 語彙検索を pgroonga から pg_trgm へ替える。
--
-- **pgroonga はマネージド PostgreSQL でほぼ手に入らない。**確認できたのは Supabase（3.2.5）と
-- Alibaba Cloud RDS（4.0.4）だけで、Neon / AWS RDS / Cloud SQL / Azure のどれにも無く、
-- Neon は任意の拡張を入れることもできない。自前運用をやめる以上、語彙側を移せる形にする。
--
-- **索引は張らない。**`ilike '%語%'` を `exists (select 1 from unnest(...))` の形で使う限り、
-- GIN + gin_trgm_ops は選ばれない（PG18 / 30,000 行で `enable_seqscan=off` にしても Seq Scan）。
-- 加えて日本語の 2 文字語からは完全なトライグラムが取り出せない。
-- **張ると使われないまま 12 MB を払う**ので置かない。
-- コーパスが増えて Seq Scan が問題になったら、そのとき測って設計し直す。
--
-- **`pgroonga_vacuum()` を先に叩く。**pgroonga の索引は `pg_relation_size` が 0 bytes を返し、
-- `drop index` では容量が戻らない（実測: 342 MB が残った）。

drop index if exists node_text_pgroonga;
drop index if exists record_text_pgroonga;
drop index if exists asset_text_pgroonga;
drop index if exists term_pgroonga;

-- 拡張ごと落とす前に容量を返させる。pgroonga が入っていない環境では関数が無いので飛ばす。
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pgroonga') then
    perform pgroonga_vacuum();
  end if;
end $$;

-- **拡張そのものは落とさない。**`drop extension` は所有者でないと通らず、
-- mitos が接続する管理ロールは所有者ではない（実測: `must be owner of extension pgroonga`）。
-- 索引を落として `pgroonga_vacuum()` を叩けば容量は返る（実測: 454 MB → 175 MB）ので、
-- **拡張の削除は DB の所有者が別途やる。**残っていても検索経路はもう使わない。

create extension if not exists pg_trgm with schema extensions;
