-- 作業場所。**リポジトリではなくディレクトリ**が単位。
-- git init していないディレクトリで作業することが多く（実測: 作業ディレクトリ 7 件中 3 件が git 管理外）、
-- リポジトリ名を識別子にできないため。
create table scope (
  id          bigint generated always as identity primary key,
  -- 識別子。git があれば正規化した remote URL、無ければ絶対パス。
  -- remote を優先するのは、マシンをまたいでも同じものを指せるから。
  ident       text not null unique,
  ident_kind  text not null check (ident_kind in ('git-remote','abs-path')),
  abs_path    text,                 -- このマシンでの場所。マシンごとに違いうるので識別子にしない
  host_org    text,                 -- 'macbee-planet' など。表示と候補提示にだけ使う
  repo_name   text,
  label       text not null,        -- 人が読む名前
  -- Claude が中を見て書く。何のリポジトリで、他とどう繋がるか。
  role        text,                 -- 'frontend' | 'dbt' | 'infra' など。自由記述
  summary     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 束。**org では束ねられない**（実測: 関連する 5 件が macbee-planet と netmarketing にまたがっていた）。
-- 推論をやめて、人が名前を付けて選ぶ。
create table scope_group (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  note       text,
  created_at timestamptz not null default now()
);

-- 多対多。1 つのディレクトリが複数の束に属せる
-- （アプリのリポジトリが「事業」と「データ基盤」の両方に関係することがあるため）。
create table group_member (
  group_id bigint not null references scope_group(id) on delete cascade,
  scope_id bigint not null references scope(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, scope_id)
);

create index on group_member (scope_id);

comment on table scope is '作業場所。ディレクトリ単位。git の有無に依らず成立する';
comment on column scope.ident is 'git remote（正規化）か絶対パス。マシンをまたいで同じものを指すための識別子';
comment on table scope_group is '関連するディレクトリの束。人が命名し、人が選ぶ。推論しない';
;
