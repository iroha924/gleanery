-- 記録 1 本 = progress-log が生成する 1 つの文書
create table record (
  id           text primary key,
  scope_id     bigint not null references scope(id) on delete restrict,
  schema_ver   text not null,
  title        text not null,
  status       text not null check (status in ('planning','in-progress','blocked','paused','done','abandoned')),
  branch       text,
  hosts        text[] not null default '{}',
  problem      text not null,
  goal         text not null,
  current_at   timestamptz,
  current_text text,
  -- 表示のためだけに持つ。WHERE に来ないので JSONB。
  phases       jsonb not null default '[]',
  next         jsonb not null default '[]',
  created_at   timestamptz not null,
  updated_at   timestamptz not null,
  ended_at     timestamptz,
  raw          jsonb not null,       -- 取り込んだ IR 全文。投影の再構築元
  raw_hash     text not null,
  ingested_at  timestamptz not null default now(),
  embedding    extensions.vector(1024)   -- title + problem + goal（「似た取り組み」用）
);
create index on record (scope_id, updated_at desc);

-- 失敗の指紋。再発の検出はベクトルでやらない。
-- コマンドとエラー先頭行の正規化ハッシュが一致するかだけを見る。閾値もモデルも要らない。
create table failure_sig (
  sig         text primary key,
  cmd_norm    text,
  err_norm    text,
  first_seen  timestamptz,
  last_seen   timestamptz,
  hits        int not null default 0,
  resolved_by bigint,
  note        text
);

-- 意味の単位。**kind をまたいで 1 表**にする。
-- 「認証で行き止まりになった話」は dead_end にも棄却された案にも失敗した検証にもあるので、
-- 表を分けるとベクトル索引が割れて 1 クエリで引けなくなる。
create table node (
  id           bigint generated always as identity primary key,
  record_id    text not null references record(id) on delete cascade,
  scope_id     bigint not null references scope(id) on delete restrict,  -- 非正規化。絞り込みの主キー
  parent_id    bigint references node(id) on delete cascade,             -- option → その decision
  -- enum ではなく text + check。ドメイン知識の種別を後から足すため（用語・仕様・FAQ など）。
  kind         text not null check (kind in ('event','decision','option','question','verification','boundary')),
  key          text not null,
  ordinal      int not null default 0,
  at           timestamptz,

  text         text not null,    -- 検索と再ランクに使う本文
  subkind      text,             -- event の kind / boundary の constraint|non-goal / option の chosen|rejected
  status       text,
  -- 否定形検索の主役。「触ると決めた」と「触らないと決めた」は埋め込み空間でほぼ同じ位置に来るので、
  -- 極性はベクトルではなく列で持つ。取り込み時に機械が決める。
  polarity     text check (polarity in ('do','dont','na')),
  confidence   text check (confidence in ('fact','inference','opinion')),
  actor_kind   text check (actor_kind in ('human','ai','ci','unknown')),
  actor_name   text,
  phase_id     text,

  attrs        jsonb not null default '{}',
  failure_sig  text references failure_sig(sig),

  content_hash text not null,
  deleted_at   timestamptz,

  embed_text   text,
  embed_model  text,
  embedded_at  timestamptz,
  embedding    extensions.vector(1024),

  unique (record_id, kind, key)
);

alter table failure_sig
  add constraint failure_sig_resolved_by_fkey
  foreign key (resolved_by) references node(id) on delete set null;

comment on column node.polarity is '否定形の検索用。dont は「やらない」「棄却した」「行き止まり」。取り込み時に導出する';
comment on column node.kind is 'text + check にしてあるのは、後からドメイン知識の種別を足すため';
;
