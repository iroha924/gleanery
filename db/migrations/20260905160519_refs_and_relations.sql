-- 外部の実体。issue / PR / commit / file / url / command。
-- 正規形が一意なので、決定論的な突き合わせ（網羅の検査）の対象になる。
-- 日付・時刻・数値は表現の揺れが大きく照合が破綻するので、ここには入れない。
create table ref (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('issue','pr','commit','file','url','command')),
  repo       text,
  key        text not null check (key <> ''),
  title      text,
  state      text,
  url        text,
  fetched    boolean,          -- 本文まで取れたか。取れなかったことを黙って空にしない
  alive      boolean,          -- 直近の存在確認。消えたコミットやパスを検出する
  checked_at timestamptz
);
-- repo が null の行どうしも衝突させたいので、式で一意にする
create unique index ref_ident on ref (kind, coalesce(repo, ''), key);

create table ref_link (
  id        bigint generated always as identity primary key,
  ref_id    bigint not null references ref(id) on delete cascade,
  record_id text not null references record(id) on delete cascade,
  node_id   bigint references node(id) on delete cascade,
  role      text not null check (role in ('evidence','link','touched','blocked_by','parent','pr_of_branch')),
  note      text,
  exit_code int
);
create unique index ref_link_ident on ref_link (ref_id, record_id, role, coalesce(node_id, 0));
create index on ref_link (node_id);

-- node 同士の関係。**記録をまたげるのがここ**。
-- 「3 ヶ月前の別作業の決定をいま覆した」「この検証がこの決定を確かめた」は、
-- 記録の中だけでは表現できない。
create table relation (
  from_node  bigint not null references node(id) on delete cascade,
  to_node    bigint not null references node(id) on delete cascade,
  kind       text not null check (kind in (
    'supersedes',   -- 決定が決定を覆した
    'contradicts',  -- 両立しない主張
    'corrects',     -- fact と名乗った主張が後から誤りだった
    'repeats',      -- 同じ行き止まりの再来
    'answers',      -- 決定や発見が未解決の問いに答えた
    'verifies',     -- 検証が決定の確かめ方を実際に確かめた
    'repays',       -- 意図して残した負債を返した
    'depends_on'
  )),
  source     text not null check (source in ('record','auto','human')),
  score      real,
  note       text,
  created_at timestamptz not null default now(),
  primary key (from_node, to_node, kind)
);
create index on relation (to_node, kind);

-- 不一致の候補。**却下を覚えるのが要点**。
-- 覚えないと同じ組を永久に出し続け、3 回目には誰も見なくなる。
create table conflict (
  a            bigint not null references node(id) on delete cascade,
  b            bigint not null references node(id) on delete cascade,
  similarity   real not null,
  detected_at  timestamptz not null default now(),
  verdict      text not null default 'unreviewed'
    check (verdict in ('unreviewed','real','not-a-conflict','resolved')),
  verdict_note text,
  verdict_at   timestamptz,
  primary key (a, b),
  check (a < b)
);

-- 用語。**記録単位ではなくスコープ単位**にする。
-- 記録ごとに持つと、同じ語を毎回書き直すことになって腐る。
create table term (
  scope_id     bigint not null references scope(id) on delete cascade,
  term         text not null,
  meaning      text not null,
  first_record text references record(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (scope_id, term)
);
;
