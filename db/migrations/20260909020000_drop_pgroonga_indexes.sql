-- pgroonga の索引を落として容量を返す。語彙検索はもうこれを使わない。
--
-- **マネージド PostgreSQL には pgroonga がほぼ無い。**確認できたのは Supabase（3.2.5）と
-- Alibaba Cloud RDS（4.0.4）だけで、Neon / AWS RDS / Cloud SQL / Azure のどれにも無く、
-- Neon は任意の拡張を入れることもできない。自前運用をやめる以上、語彙側は拡張に
-- 依存しない形（`ilike '%語%'` の部分一致）へ寄せる。実測（20 問）: 出荷経路の
-- recall@5 は pgroonga でも部分一致でも 95%、語彙側を外すと 85%。
--
-- **索引は張り替えない。**`ilike '%語%'` を相関副問い合わせの中で使う限り、
-- GIN + gin_trgm_ops は選ばれない（PG18 / 30,000 行で `enable_seqscan=off` にしても Seq Scan）。
-- 一度張って本番で `idx_scan = 0`、12 MB の払い損だった。
-- コーパスが増えて Seq Scan が問題になったら、そのとき測って設計し直す。
--
-- **拡張そのものは落とさない。**`drop extension` は所有者でないと通らず、mitos が繋ぐ
-- 管理ロールは所有者ではない（実測: `must be owner of extension pgroonga`）。
-- 索引を落として `pgroonga_vacuum()` を叩けば容量は返る（実測: 454 MB → 175 MB）ので、
-- 拡張の削除は DB の所有者が別途やる。

drop index if exists node_text_pgroonga;
drop index if exists record_text_pgroonga;
drop index if exists asset_text_pgroonga;
drop index if exists term_pgroonga;

-- pgroonga の索引は `pg_relation_size` が 0 bytes を返し、`drop index` では容量が戻らない
-- （実測: 342 MB が残った）。pgroonga が入っていない環境では関数ごと無いので飛ばす。
--
-- **スキーマ修飾する。**pgroonga は `extensions` に置いてあり、DB の既定の search_path
-- （`"$user", public`）はそこを含まない（実測: 修飾なしだと
-- `function "pgroonga_vacuum" does not exist`）。`db.ts` は接続のたびに search_path を
-- 足すが、psql で直に流す経路はそれを通らない。
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pgroonga') then
    perform extensions.pgroonga_vacuum();
  end if;
end $$;
