-- schema.sql が作らない pg_trgm 拡張を消す。依存するものまで消さないよう cascade は付けない。
drop extension if exists pg_trgm;
