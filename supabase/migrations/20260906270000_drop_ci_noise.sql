-- 自動通知を物理削除する。
--
-- 墓標（deleted_at）にしただけでは検索から外れるだけで、行は残り続ける。
-- 実測: node は 731MB（本体 105MB / HNSW 索引 338MB / 埋め込みの実体 288MB）で、
-- 40,844 行のうち 16,994 行（41%）が Terraform の plan 結果・デプロイ URL・カバレッジ表だった。
-- **HNSW は削除済みの行もグラフを辿る**ので、置いておくと検索のたびに IO を払い続ける。
-- Supabase から Disk IO Budget の警告が来たのが直接のきっかけ。
--
-- 失うのは CI 通知の本文だけ。「いつ何をリリースしたか」はリリース PR
-- （macbeeplanet-dev[bot] が作る）を取り込むようにしたので、そちらのほうが正確。
-- 戻したくなったら import-github を回し直せば入る。
--
-- **一度に消さない。**1 行に 12KB の埋め込みが付くので、全件を 1 文で消すと
-- WAL が一気に膨らみ、statement_timeout にも当たる。
set statement_timeout = '30min';

-- **この 1 文を、0 行になるまで繰り返し実行する。**
-- procedure の中で commit する形も試したが、複数文をまとめて送ると暗黙の
-- トランザクションに入るため `_SPI_commit` で弾かれた（実測）。
-- 呼び出し側から 1 文ずつ投げるほうが、チャンクごとに確定できて確実。
delete from public.node
 where id in (
   select id from public.node where actor_kind = 'ci' and deleted_at is not null limit 2000
 );

-- 消した分の領域を再利用できるようにする。**FULL は付けない** —
-- 全体を書き直すので、いま減らしたい IO をむしろ大きく払うことになる。
vacuum (analyze) public.node;
