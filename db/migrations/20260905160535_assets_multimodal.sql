-- 画像のナレッジ。スクリーンショットや構成図。
-- voyage-multimodal-3.5 は voyage-4-large と**別の埋め込み空間**なので、
-- 同じ列に混ぜられない。テーブルを分けるのは仕様上の必然であって、設計の好みではない。
create table asset (
  id          bigint generated always as identity primary key,
  scope_id    bigint not null references scope(id) on delete restrict,
  record_id   text references record(id) on delete cascade,
  node_id     bigint references node(id) on delete set null,   -- どの決定・発見に紐づくか

  kind        text not null check (kind in ('screenshot','diagram','photo','other')),
  storage_path text not null,        -- 画像の実体の置き場所。**取り込む経路はまだ無い**（実データ 0 行）
  mime        text,
  width       int,
  height      int,
  sha256      text,                  -- 同じ画像を二重に入れないため

  -- 画像だけでは後から意味が分からない。何の画面か、何を示しているかを言葉で持つ。
  caption     text not null,
  ocr_text    text,                  -- 画面内の文字。語彙検索に効く
  taken_at    timestamptz,

  embed_model text,
  embedded_at timestamptz,
  embedding   extensions.vector(1024),   -- multimodal 空間。node.embedding とは別物

  created_at  timestamptz not null default now()
);
create unique index asset_sha on asset (sha256) where sha256 is not null;
create index on asset (scope_id, created_at desc);
create index on asset (node_id);

comment on table asset is '画像のナレッジ。embedding は multimodal の空間で、node.embedding と互換性が無い';
comment on column asset.caption is '画像だけでは後から意味が取れないので、言葉での説明を必須にする';
;
