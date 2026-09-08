-- ベクトル検索と、日本語の語彙検索。
-- pgroonga を使うのは、内容が日本語だから。pg_trgm は日本語の分かち書きを持たない。
-- 脱落検出では n-gram の重なりが意味ベースの指標を上回るという実測もあり、
-- ベクトルと語彙の併用には根拠がある。
create extension if not exists vector with schema extensions;
create extension if not exists pgroonga;
;
