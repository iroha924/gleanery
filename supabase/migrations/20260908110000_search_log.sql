-- 何を聞かれたかを残す。
--
-- **これが無いと「使うほど良くなる」は測れない。**引いた結果が役に立ったかを見るには、
-- まず何を引きにきたかが要る。今は search_knowledge の呼び出しがどこにも残らないので、
-- 「ナレッジに何が足りないか」を答える手段が 1 つも無い。
--
-- **ナレッジではない。**chat 表と同じ理由で record / node から分ける。ここに溜まるのは
-- 問いと、そのとき何位で何が返ったかという観測であって、「なぜそうしたか」ではない。
-- 検索はこの表を一切 join しないので、ここへ何を書いても検索結果は変わらない。
create table if not exists public.search_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  -- mcp（Claude / Codex）/ cli / chat のどれが引いたか
  source        text not null check (source in ('mcp', 'cli', 'chat')),
  scope_id      bigint references public.scope(id) on delete set null,
  cwd           text,
  question      text not null,
  kinds         text[],
  only_rejected boolean not null default false,
  all_scopes    boolean not null default false,
  hits          int not null default 0,
  -- 上位 1 件の再ランク関連度（0〜1）。**低い＝聞かれたのに答えを持っていなかった。**
  -- 「引けなかった問い」はここで拾う。件数ではなく関連度で見るのは、
  -- 検索は常に上位 N 件を返すので、件数が 0 になることがほとんど無いため。
  relevance     real,
  -- ベクトルの素の近さ。範囲外の判定に使っているものと同じ尺度
  top_score     real,
  node_ids      bigint[] not null default '{}'
);
create index if not exists search_log_at on public.search_log (at desc);
-- 「答えを持っていなかった問い」を新しい順に引く
create index if not exists search_log_weak on public.search_log (relevance, at desc) where relevance is not null;

alter table public.search_log enable row level security;
alter table public.search_log force row level security;

-- **MCP には insert しか渡さない。**推論する層と資格情報を持つ層を分ける方針
-- （20260906120000_readonly_role_for_mcp.sql）は、守っている対象がナレッジ本体である。
-- 追記しかできず、読み戻せず、消せもしない観測ログはその対象ではない。
-- select を与えないので、MCP は自分が書いたものを引くことすらできない。
-- **シーケンスの権限は要らない。**`generated always as identity` は PostgreSQL 10 以降
-- 内部で採番するので、`serial` の `nextval()` と違って権限を要求しない（実測: 外しても
-- insert は通った）。与えると `last_value` が読め、「読み戻せない」に検索回数という穴が開く。
grant insert on public.search_log to knowledge_ro;
drop policy if exists search_log_append_ro on public.search_log;
create policy search_log_append_ro on public.search_log for insert to knowledge_ro with check (true);

-- 読むのは画面と CLI。
grant select, insert, delete on public.search_log to mitos_cfg;
drop policy if exists search_log_cfg on public.search_log;
create policy search_log_cfg on public.search_log for all to mitos_cfg using (true) with check (true);

-- **既定の権限が select を自動で付けてしまう。**
-- 20260906120000_readonly_role_for_mcp.sql の
-- `alter default privileges in schema public grant select on tables to knowledge_ro`
-- は、後から作った表にも効く。search_log もそれを受け取っていた（実測: RLS が 0 行に
-- していただけで、権限としては読めていた）。
--
-- 同じ移行が「RLS は force で有効」と書きつつ権限の側でも読み取りに限っているのは、
-- 片方が外れたときにもう片方が残るようにするためである。ここは向きが逆で、
-- **追記だけを許して読み戻しを許さない**ので、select を明示的に取り上げる。
revoke select on public.search_log from knowledge_ro;
