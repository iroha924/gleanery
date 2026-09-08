-- 設計文書と ADR を置けるようにする。
--
-- **リポジトリが消えると、そこにしか無い判断も消える。**PR・issue・会話には
-- 取り込み口があったが、docs/ の Markdown には無かった。実装より先に設計を
-- 文書へ書く進め方だと、いちばん考えた部分だけが 1 行も入らない
-- （実測: nomophyl は仕様 4 本と ADR 3 本で 9,458 行あり、全部が対象外だった）。
--
-- kind を text + check にしてあるのは「後からドメイン知識の種別を足すため」と
-- 20260905160457_record_and_node.sql が宣言している。これがその 1 つ目。
alter table public.node drop constraint if exists node_kind_check;
alter table public.node add constraint node_kind_check check (
  kind = any (array[
    'event','decision','option','question','verification','boundary','utterance',
    -- リポジトリの Markdown。subkind で adr / doc を分ける
    'doc'
  ])
);
