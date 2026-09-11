-- GitHub App の接続状態。installation token は 1 時間で失効するため保存せず、必要時に生成する。
create table github_installation (
  id                   bigint primary key,
  account_login        text not null,
  account_type         text not null,
  repository_selection text not null check (repository_selection in ('all', 'selected')),
  status               text not null check (status in ('active', 'suspended')),
  installed_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table github_repository (
  id                bigint primary key,
  installation_id   bigint not null references github_installation(id) on delete cascade,
  scope_id           bigint not null references scope(id) on delete restrict,
  full_name          text not null unique,
  private            boolean not null,
  selected           boolean not null default true,
  sync_status        text not null default 'queued'
    check (sync_status in ('queued', 'syncing', 'synced', 'error')),
  sync_requested_at timestamptz,
  last_synced_at    timestamptz,
  last_error        text,
  updated_at        timestamptz not null default now()
);

create index github_repository_installation on github_repository (installation_id) where selected;

alter table github_installation enable row level security;
alter table github_installation force row level security;
alter table github_repository enable row level security;
alter table github_repository force row level security;

grant select, insert, update, delete on github_installation, github_repository to mitos_cfg;
create policy github_installation_cfg on github_installation for all to mitos_cfg using (true) with check (true);
create policy github_repository_cfg on github_repository for all to mitos_cfg using (true) with check (true);

-- 画面/APIと別の鍵。GitHub由来の記録と同期状態だけを書ける。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mitos_github') then
    create role mitos_github login;
  end if;
end $$;

revoke all on all tables in schema public from mitos_github;
revoke all on all sequences in schema public from mitos_github;
grant usage on schema public, extensions to mitos_github;
grant select on scope, github_installation, github_repository, record, node, ref, ref_link to mitos_github;
grant insert on record, node, ref, ref_link to mitos_github;
grant update (updated_at, ingested_at) on record to mitos_github;
grant update (
  at, text, status, attrs, subkind, actor_kind, actor_name, content_hash, deleted_at,
  embed_text, embed_model, embedded_at, embedding
) on node to mitos_github;
grant update (url) on ref to mitos_github;
grant update (sync_status, sync_requested_at, last_synced_at, last_error, updated_at)
  on github_repository to mitos_github;
grant usage, select on sequence node_id_seq, ref_id_seq, ref_link_id_seq to mitos_github;

create policy scope_read_github on scope for select to mitos_github using (true);
create policy github_installation_read_worker on github_installation for select to mitos_github using (true);
create policy github_repository_read_worker on github_repository for select to mitos_github using (true);
create policy github_repository_update_worker on github_repository for update to mitos_github
  using (true) with check (true);
create policy record_read_worker on record for select to mitos_github using (true);
create policy record_insert_worker on record for insert to mitos_github with check (true);
create policy record_update_worker on record for update to mitos_github using (true) with check (true);
create policy node_read_worker on node for select to mitos_github using (true);
create policy node_insert_worker on node for insert to mitos_github with check (true);
create policy node_update_worker on node for update to mitos_github using (true) with check (true);
create policy ref_read_worker on ref for select to mitos_github using (true);
create policy ref_insert_worker on ref for insert to mitos_github with check (true);
create policy ref_update_worker on ref for update to mitos_github using (true) with check (true);
create policy ref_link_read_worker on ref_link for select to mitos_github using (true);
create policy ref_link_insert_worker on ref_link for insert to mitos_github with check (true);

comment on table github_installation is 'GitHub App installation。tokenや秘密鍵は保存しない';
comment on table github_repository is 'installationがアクセスできるリポジトリと同期状態';
