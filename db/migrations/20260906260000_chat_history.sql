-- チャットの履歴。
--
-- **ナレッジではない。**record / node は「なぜそうしたか」を貯める場所で、
-- そこへ生成した答えを書き戻すと、誤りが記録に化けて次の答えがそれを引用する
-- （自分の出力を自分の根拠にする輪ができる）。だから表を分ける。
--
-- 書けるのは画面の鍵（mitos_cfg）だけ。ナレッジ本体には触れない。
create table if not exists public.chat (
  id         uuid primary key default gen_random_uuid(),
  title      text,                              -- 最初の質問から作る
  scope_ids  int[] not null default '{}',       -- そのとき見ていたプロジェクトの範囲
  scope_name text,                              -- 表示用。あとで束が消えても読める
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_message (
  id       bigint generated always as identity primary key,
  chat_id  uuid not null references public.chat(id) on delete cascade,
  role     text not null check (role in ('user', 'assistant')),
  content  text not null,
  -- 答えの根拠。**あとから「何を見て言ったか」を確かめられるようにする。**
  sources  jsonb not null default '[]',
  at       timestamptz not null default now()
);
create index if not exists chat_message_chat on public.chat_message (chat_id, at);
create index if not exists chat_updated on public.chat (updated_at desc);

alter table public.chat enable row level security;
alter table public.chat force row level security;
alter table public.chat_message enable row level security;
alter table public.chat_message force row level security;

grant select on public.chat, public.chat_message to knowledge_ro;
grant select, insert, update, delete on public.chat, public.chat_message to mitos_cfg;
grant usage, select on sequence public.chat_message_id_seq to mitos_cfg;

do $$
declare t text;
begin
  foreach t in array array['chat', 'chat_message'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read_ro', t);
    execute format('create policy %I on public.%I for select to knowledge_ro using (true)', t || '_read_ro', t);
    execute format('drop policy if exists %I on public.%I', t || '_read_cfg', t);
    execute format('create policy %I on public.%I for select to mitos_cfg using (true)', t || '_read_cfg', t);
    execute format('drop policy if exists %I on public.%I', t || '_write_cfg', t);
    execute format('create policy %I on public.%I for insert to mitos_cfg with check (true)', t || '_write_cfg', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_cfg', t);
    execute format('create policy %I on public.%I for update to mitos_cfg using (true) with check (true)', t || '_update_cfg', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_cfg', t);
    execute format('create policy %I on public.%I for delete to mitos_cfg using (true)', t || '_delete_cfg', t);
  end loop;
end $$;
