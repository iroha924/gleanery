-- ベクトル検索と、日本語の語彙検索。
-- **語彙側は pg_trgm。**分かち書きは持たないが、語彙側の仕事は順位ではなく
-- 「正解を候補へ入れること」で、順位は再ランクが付け直す。実測（2026-09-09、20 問）:
-- 出荷経路の recall@5 は pgroonga 95% / pg_trgm 95% / 語彙側なし 85%。
--
-- **pgroonga から替えた。**マネージドで手に入るのが Supabase と Alibaba だけで、
-- 配布する以上「誰でも用意できる DB」で動く必要がある。索引も 386 MB → 12 MB に減る。
--
-- **ロケールに依存する。**`C` ロケールの DB では show_trgm が日本語に対して空を返し、
-- エラーも出ずに語彙側が丸ごと死ぬ。`C.UTF-8` か `en_US.UTF-8` なら切れる（どちらも実測）。
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
;
