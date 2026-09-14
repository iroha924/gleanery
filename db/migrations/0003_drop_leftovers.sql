-- schema.sql が作らない拡張と関数（旧 migration の残り）を消す。依存するものまで消さないよう cascade は付けない。
drop extension if exists pg_trgm, pgcrypto, "uuid-ossp";
drop function if exists public.rls_auto_enable();
