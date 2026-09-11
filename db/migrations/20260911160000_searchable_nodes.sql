alter table public.node
  add column searchable boolean not null default true;

update public.node n
set searchable = false,
    embed_text = null,
    embed_model = null,
    embedded_at = null,
    embedding = null
from public.record r
where r.id = n.record_id
  and r.schema_ver like 'session/%';

comment on column public.node.searchable is
  'false はセッション詳細には保持するが、横断検索とパス警告の候補にしない';
