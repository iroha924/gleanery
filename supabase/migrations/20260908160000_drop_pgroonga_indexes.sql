-- 使っていない全文検索の索引を落とす。
--
-- **出荷している検索は pgroonga を使っていない。**`server/src/search.ts` の冒頭が
-- 「ハイブリッド（pgroonga との融合）を入れないのも、効果を測れていないものを足さないから。
-- 索引は残してあるので、データが増えたら測り直せる」と書いていた。**その「残してある」の代償が
-- データベースの 87% だった。**
--
-- 実測（2026-09-08、node 2,926 件）:
--   落とす前              501 MB（うちテーブル全部で 66 MB）
--   索引を 3 本落とす     501 MB  ← **変わらない**
--   pgroonga_vacuum()     159 MB  ← ここで 342 MB が解放される
--
-- **DROP INDEX だけでは戻らない。**pgroonga は Groonga のデータベースファイルを
-- リレーションの外に持ち、`pg_relation_size` は 0 bytes と報告する。
-- 落とした後に `select pgroonga_vacuum();` が要る。
--
-- 検索は変わらない。20 問の eval で、出荷経路は落とす前後とも
-- top1 80% / recall@5 95% / MRR 0.867（語彙のみは前から 0%）。
--
-- **戻せる。**索引は node.text から作り直せる導出物なので、
-- 語彙側を測り直したくなったら create index するだけでよい。
drop index if exists public.node_text_pgroonga;
drop index if exists public.record_text_pgroonga;
drop index if exists public.asset_text_pgroonga;
