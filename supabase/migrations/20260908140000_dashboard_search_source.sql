-- 画面の検索ページも「答えを持てなかった問い」の入口である。
-- chat（生成する側）と分けて数えられるようにする。
alter table public.search_log drop constraint if exists search_log_source_check;
alter table public.search_log add constraint search_log_source_check
  check (source in ('mcp', 'cli', 'chat', 'dashboard'));

-- `generated always as identity` はシーケンス権限を要求しない（実測: 外しても insert は通る）。
-- knowledge_ro 側は 20260908110000 で外した。mitos_cfg 側も揃える。
revoke all on sequence public.search_log_id_seq from mitos_cfg;
