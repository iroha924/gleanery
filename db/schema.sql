-- mitos の DB の正本。持ち主 1 人が、どの PC からでも同じ判断と会話を引くためにある。
--
-- 境界は 3 つ。取り込み元の今の状態（connector / source_item）、逐語の会話（conversation / message）、
-- 検索する知識（knowledge）。作業の現在地（work_item）は更新される状態なので知識とは表を分ける。
--
-- 版は schema のコメントに置く。MCP・CLI・画面の API は最初に DB を使うときに server/src/db.ts の SCHEMA_REVISION と
-- 突き合わせ、食い違えば止まる。適用と作り直しは `bun run db:apply` / `bun run db:reset`（server/src/admin.ts）。
-- 名前は常に schema を付けて書く。接続ごとの search_path に依存しない。

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create schema mitos;
comment on schema mitos is 'mitos schema revision 2';
revoke all on schema mitos from public;

-- git remote を正規化した key（`git:github.com/owner/repo`）か、remote の無い作業場所に各 PC の設定で付けた key。
-- ローカルのパスは置かない。置き場所は PC ごとに違う。
create table mitos.project (
  id bigint generated always as identity primary key,
  key text not null unique check (key ~ '^(git:[^[:space:]]+|local:[a-z0-9][a-z0-9._-]*)$'),
  name text not null check (name <> ''),
  created_at timestamptz not null default now()
);

create table mitos.person (
  id bigint generated always as identity primary key,
  display_name text not null unique check (display_name <> ''),
  is_self boolean not null default false
);
-- 質問者本人は 1 人だけ。「私はなんて言った？」の「私」をここで決める。
create unique index person_one_self on mitos.person (is_self) where is_self;

-- 取り込み元での識別子。GitHub の user id は login を変えても同じなので external_id に置く。
create table mitos.person_identity (
  id bigint generated always as identity primary key,
  person_id bigint references mitos.person (id) on delete set null,
  provider text not null check (provider in ('github')),
  external_id text not null,
  handle text not null,
  unique (provider, external_id)
);
create index person_identity_handle on mitos.person_identity (provider, lower(handle));

-- 取り込み元ごとの、最後に入れた版と直近の成否。secret は置かない（同期する PC の環境にある）。
-- 文書は入れた commit（head_oid）。次の同期は、それから fast-forward できる commit だけを自動で入れる。
-- GitHub は取得を始めた DB の時刻（snapshot_at）。それより前に始めた取得は、遅れて commit しても書かない。
create table mitos.connector (
  id bigint generated always as identity primary key,
  project_id bigint not null references mitos.project (id) on delete cascade,
  provider text not null check (provider in ('github', 'docs')),
  head_oid text check (head_oid is null or (provider = 'docs' and head_oid ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')),
  snapshot_at timestamptz check (snapshot_at is null or provider = 'github'),
  last_success_at timestamptz,
  last_error text,
  unique (project_id, provider)
);

-- 取り込み元の今の状態。消えたと完全な一覧で確かめられた項目は行ごと消す（墓標を置かない）。
-- 文書は原文を body に持つ。画面が成果物の全文を出す。検索するのは knowledge の節で、節の連結から原文は戻さない。
create table mitos.source_item (
  id bigint generated always as identity primary key,
  connector_id bigint not null references mitos.connector (id) on delete cascade,
  external_id text not null,
  kind text not null check (kind in ('pull_request', 'issue', 'document', 'requirements', 'design')),
  title text not null check (title <> ''),
  state text,
  url text,
  path text check (path <> '' and path !~ '^/' and path !~ '(^|/)\.\.(/|$)'),
  body text,
  author_identity_id bigint references mitos.person_identity (id) on delete set null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  -- PR はマージした時刻（マージせず閉じたなら閉じた時刻）、issue は閉じた時刻。開いているものと文書は null。
  closed_at timestamptz,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  synced_at timestamptz not null default now(),
  unique (connector_id, external_id),
  check (
    case
      when kind in ('document', 'requirements', 'design') then path is not null and body is not null and state is null
        and closed_at is null
      else path is null and body is null and state in ('open', 'merged', 'closed') and (state = 'open') = (closed_at is null)
    end
  )
);
create index source_item_listing on mitos.source_item (connector_id, kind, state, source_updated_at desc);

-- coding session、または GitHub の PR / issue 1 件ぶんの会話。
-- id は (project, origin, external_id) から決定的に作る。同じ session を 2 回送っても行が増えない。
create table mitos.conversation (
  id uuid primary key,
  project_id bigint not null references mitos.project (id) on delete cascade,
  source_item_id bigint references mitos.source_item (id) on delete cascade,
  origin text not null check (origin in ('claude-code', 'codex', 'github')),
  external_id text not null,
  branch text,
  started_at timestamptz not null,
  unique (project_id, origin, external_id),
  check ((origin = 'github') = (source_item_id is not null))
);
create index conversation_recent on mitos.conversation (project_id, started_at desc);

-- 1 発言 1 行。self は持ち主が打った発言、assistant は AI の最後の応答か AI レビュアー、bot は自動通知。
-- 大きすぎる発言は冒頭と末尾だけを残し、truncated と元の大きさを持つ。
-- lexemes は語に切った索引（Intl.Segmenter）。coding session の AI の応答には付けない。
create table mitos.message (
  id uuid primary key,
  conversation_id uuid not null references mitos.conversation (id) on delete cascade,
  external_id text not null,
  turn_id text,
  reply_to_id uuid references mitos.message (id) on delete set null,
  speaker_kind text not null check (speaker_kind in ('self', 'person', 'assistant', 'bot')),
  identity_id bigint references mitos.person_identity (id) on delete set null,
  body text not null check (body <> ''),
  truncated boolean not null default false,
  original_bytes integer not null check (original_bytes > 0),
  url text,
  sent_at timestamptz not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  lexemes tsvector,
  unique (conversation_id, external_id),
  check (truncated or original_bytes = octet_length(body)),
  check (not truncated or original_bytes > octet_length(body))
);
create index message_order on mitos.message (conversation_id, sent_at);
create index message_by_identity on mitos.message (identity_id, sent_at desc) where identity_id is not null;
create index message_self on mitos.message (sent_at desc) where speaker_kind = 'self';
create index message_lexemes on mitos.message using gin (lexemes);

-- 発言に結んだファイル。自動記録は、編集したファイル（edit）と読んだ要件定義・設計書（read）を、触る前に持ち主が
-- 最後にした発言へ結ぶ。GitHub の同期は、レビューで指されたファイル（review）をそのレビューの発言へ結ぶ。
-- path は project の根からの相対。
create table mitos.message_file (
  message_id uuid not null references mitos.message (id) on delete cascade,
  path text not null check (path <> '' and path !~ '^/' and path !~ '(^|/)\.\.(/|$)'),
  action text not null check (action in ('edit', 'read', 'review')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  primary key (message_id, path, action)
);
create index message_file_path on mitos.message_file (path);

-- 埋め込みは本体と分ける。本体を書き換えても索引の heap を巻き込まず、失敗も状態として残す。
-- 書き戻しは source_hash が一致するときだけ（古い結果が後から返っても上書きしない）。
create table mitos.message_embedding (
  message_id uuid primary key references mitos.message (id) on delete cascade,
  model text not null,
  source_hash bytea not null check (octet_length(source_hash) = 32),
  status text not null check (status in ('pending', 'ready', 'error')),
  attempts integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  embedding extensions.halfvec(1024),
  check ((status = 'ready') = (embedding is not null))
);

-- 作業の現在地。trace が更新する。active / blocked / paused が「続きをやる」の候補。
create table mitos.work_item (
  id bigint generated always as identity primary key,
  project_id bigint not null references mitos.project (id) on delete cascade,
  source_key text not null,
  title text not null check (title <> ''),
  goal text not null check (goal <> ''),
  current text not null check (current <> ''),
  next text[] not null default '{}',
  status text not null check (status in ('active', 'blocked', 'paused', 'done', 'abandoned')),
  conversation_id uuid references mitos.conversation (id) on delete set null,
  updated_at timestamptz not null,
  unique (project_id, source_key)
);
create index work_item_open on mitos.work_item (project_id, updated_at desc)
  where status in ('active', 'blocked', 'paused');

-- 検索する知識の単位。trace が会話から選んだ判断と、文書の節。
-- 覆した決定は消さない（消すと再提案される）。superseded にして後継を指す。
-- stance は種類と状態から決まる。「通ってはいけない道」だけを引くときの絞り込みに使う。
create table mitos.knowledge (
  id bigint generated always as identity primary key,
  project_id bigint not null references mitos.project (id) on delete cascade,
  source_item_id bigint references mitos.source_item (id) on delete cascade,
  conversation_id uuid references mitos.conversation (id) on delete cascade,
  work_item_id bigint references mitos.work_item (id) on delete set null,
  source_key text not null,
  kind text not null check (
    kind in ('decision', 'option', 'constraint', 'non_goal', 'dead_end', 'finding', 'debt',
             'verification', 'question', 'document')
  ),
  status text,
  stance text not null generated always as (
    case
      when kind in ('constraint', 'non_goal', 'debt') then case status when 'active' then 'dont' else 'neutral' end
      when kind = 'dead_end' then 'dont'
      when kind = 'option' then case status when 'chosen' then 'do' else 'dont' end
      when kind = 'decision' then case status when 'accepted' then 'do' when 'proposed' then 'neutral' else 'dont' end
      when kind = 'verification' then case status when 'failed' then 'dont' else 'neutral' end
      else 'neutral'
    end
  ) stored,
  confidence text check (confidence in ('fact', 'inference', 'opinion')),
  decision_id bigint references mitos.knowledge (id) on delete cascade,
  superseded_by_id bigint references mitos.knowledge (id) on delete set null,
  heading text,
  body text not null check (body <> ''),
  reason text,
  confirmation text,
  command text,
  downsides text[] not null default '{}',
  refs text[] not null default '{}',
  occurred_at timestamptz not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  lexemes tsvector not null,
  unique (project_id, source_key),
  check (source_item_id is not null or conversation_id is not null),
  check (kind <> 'document' or (source_item_id is not null and heading is not null)),
  check (
    case kind
      when 'decision' then status is not null and status in ('proposed', 'accepted', 'rejected', 'superseded')
      when 'option' then status is not null and status in ('chosen', 'rejected', 'was_chosen')
      when 'verification' then status is not null and status in ('passed', 'failed', 'not_run')
      when 'question' then status is not null and status in ('open', 'blocking', 'resolved')
      when 'constraint' then status is not null and status in ('active', 'retired')
      when 'non_goal' then status is not null and status in ('active', 'retired')
      when 'debt' then status is not null and status in ('active', 'retired')
      else status is null
    end
  ),
  check (
    case kind
      when 'option' then decision_id is not null
      when 'verification' then true
      else decision_id is null
    end
  ),
  check ((kind = 'decision' and status = 'superseded') = (superseded_by_id is not null)),
  check (superseded_by_id <> id),
  check (confirmation is null or kind = 'decision'),
  check (command is null or kind = 'verification'),
  check (cardinality(downsides) = 0 or kind = 'decision'),
  check (kind <> 'document' or work_item_id is null)
);
create index knowledge_listing on mitos.knowledge (project_id, kind, status, occurred_at desc);
create index knowledge_lexemes on mitos.knowledge using gin (lexemes);
create index knowledge_work on mitos.knowledge (work_item_id) where work_item_id is not null;

-- 判断とファイルの直接の関係。applies_to は編集の前に出す制約、evidence は根拠として挙げたファイル。
create table mitos.knowledge_file (
  knowledge_id bigint not null references mitos.knowledge (id) on delete cascade,
  path text not null check (path <> '' and path !~ '^/' and path !~ '(^|/)\.\.(/|$)'),
  role text not null check (role in ('applies_to', 'evidence')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  primary key (knowledge_id, path, role)
);
create index knowledge_file_path on mitos.knowledge_file (path, role);

create table mitos.knowledge_embedding (
  knowledge_id bigint primary key references mitos.knowledge (id) on delete cascade,
  model text not null,
  source_hash bytea not null check (octet_length(source_hash) = 32),
  status text not null check (status in ('pending', 'ready', 'error')),
  attempts integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  embedding extensions.halfvec(1024),
  check ((status = 'ready') = (embedding is not null))
);

-- ロールは操作ごと。PR コメントのような untrusted な文章を読む出口（MCP・画面）には書き込みを持たせない。
--   mitos_reader  読むだけ。MCP・画面の API
--   mitos_ingest  取り込みと trace。CLI の sync / trace / who / project
--   mitos_capture 会話の自動記録。追記だけで、既存の行を読めも書き換えもしない
-- ここではパスワードを付けない。鍵は `bun run db:roles`（server/src/admin.ts）が作り、env ファイルへ直接書く。
do $$
declare
  r text;
begin
  foreach r in array array['mitos_reader', 'mitos_ingest', 'mitos_capture'] loop
    if not exists (select from pg_roles where rolname = r) then
      execute format('create role %I login', r);
    end if;
  end loop;
end
$$;

grant usage on schema extensions, mitos to mitos_reader, mitos_ingest, mitos_capture;

grant select on all tables in schema mitos to mitos_reader;

grant select, insert, update, delete on all tables in schema mitos to mitos_ingest;
grant usage on all sequences in schema mitos to mitos_ingest;

-- capture が読めるのは、作業場所の対応（id・key・名前）と、ファイルを結ぶ先の発言が在るかだけ。本文は読めない。
-- 書けるのは自動記録が埋める列だけ。取り込み元（source_item）と人の身元（identity）を指す列は書けないので、
-- GitHub の会話を作ることも、他人の身元を名乗ることもできない。会話の id は決定的に計算できるので、既存の会話へ
-- 発言を足すことは列の権限では止めない（鍵が漏れた場合の残りの面）。
grant select (id, key, name) on mitos.project to mitos_capture;
grant select (id) on mitos.message to mitos_capture;
grant insert (id, project_id, origin, external_id, branch, started_at) on mitos.conversation to mitos_capture;
grant insert (id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes, sent_at,
              content_hash, lexemes) on mitos.message to mitos_capture;
grant insert (message_id, path, action) on mitos.message_file to mitos_capture;
grant insert (message_id, model, source_hash, status, embedding) on mitos.message_embedding to mitos_capture;
