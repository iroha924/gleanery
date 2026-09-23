-- gleanery の DB の正本（SQLite、`node:sqlite`）。持ち主 1 人が、その PC での判断と会話を引くためにある。
-- **PC ごとに独立していて、記録を共有しない。**1 ファイル（~/.gleanery/gleanery.db）が 1 つの DB で、schema 修飾は持たない。
--
-- 境界は 3 つ。取り込み元の今の状態（connector / source_item）、逐語の会話（conversation / message）、
-- 検索する知識（knowledge）。作業の現在地（work_item）は更新される状態なので知識とは表を分ける。
--
-- バージョンは末尾の `pragma user_version`。MCP・CLI・端末の画面は開くときに server/src/db.ts の SCHEMA_REVISION と
-- 突き合わせ、食い違えば止まる。空の DB は `gleanery db init` が作る（server/src/admin.ts）。
-- 全表 STRICT（型違いを拒む）。主キーは全部 not null を書く（SQLite は integer 以外の主キーに NULL を許す）。
-- journal_mode・foreign_keys は接続ごとに server/src/sqlite.ts が設定する（ここには書かない）。
--
-- 時刻は ISO 8601 の UTC（`Date#toISOString()` の形）の文字列で持ち、辞書順が時系列順になる。
-- `strftime(...) is 列` は正規形でない値（ミリ秒の無い `...:00Z`、時差付き、暦に無い日）を拒む。
-- 混ざると同じ秒の中で並びが狂い、日付の絞り込みが境界で外れる。

create table project (
  id integer primary key autoincrement not null,
  -- git remote を正規化した key（`git:github.com/owner/repo`）か、remote の無いプロジェクトに各 PC の設定で付けた key。
  -- ローカルのパスは置かない。置き場所は PC ごとに違う。
  key text not null unique check (
    (key glob 'git:*' and key not glob '*[ ' || char(9) || '-' || char(13) || ']*' and length(key) > 4)
    or (key glob 'local:[a-z0-9]*' and substr(key, 7) not glob '*[^a-z0-9._-]*')),
  name text not null check (name <> ''),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    check (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is created_at)
) strict;

create table person (
  id integer primary key autoincrement not null,
  display_name text not null unique check (display_name <> ''),
  is_self integer not null default 0 check (is_self in (0, 1))
) strict;
-- 質問者本人は 1 人だけ。「私はなんて言った？」の「私」をここで決める。
create unique index person_one_self on person (is_self) where is_self = 1;

-- 取り込み元での識別子。GitHub の user id は login を変えても同じなので external_id に置く。
create table person_identity (
  id integer primary key autoincrement not null,
  person_id integer references person (id) on delete set null,
  provider text not null check (provider in ('github')),
  external_id text not null,
  handle text not null,
  unique (provider, external_id)
) strict;
create index person_identity_handle on person_identity (provider, lower(handle));

-- 取り込み元ごとの、最後に入れたバージョンと直近の成否。secret は置かない（同期する PC の環境にある）。
-- 文書は入れた commit（head_oid）。次の同期は、それから fast-forward できる commit だけを自動で入れる。
-- GitHub は取得を始めた時刻（snapshot_at）。それより前に始めた取得は、遅れて commit しても書かない。
create table connector (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  provider text not null check (provider in ('github', 'docs')),
  head_oid text check (head_oid is null or (provider = 'docs'
    and (length(head_oid) = 40 or length(head_oid) = 64) and head_oid not glob '*[^0-9a-f]*')),
  snapshot_at text check (snapshot_at is null or provider = 'github')
    check (strftime('%Y-%m-%dT%H:%M:%fZ', snapshot_at) is snapshot_at),
  last_success_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) is last_success_at),
  last_error text,
  unique (project_id, provider)
) strict;

-- docs の同期で取り込まない path。追跡された Markdown が全部「事実を述べた文書」とは限らない（監査の fixture）。
-- **取り込む側の設定である。**読み取り専用のプロジェクトにも効かせたいので、リポジトリ側の manifest には置かない。
-- file は path と完全一致、directory は `<path>/` で始まる path に当たる。docs の connector にだけ作る。
create table docs_exclude (
  connector_id integer not null references connector (id) on delete cascade,
  kind text not null check (kind in ('file', 'directory')),
  path text not null check (
    path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..' and path not glob '*/'
    and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*'),
  primary key (connector_id, kind, path)
) strict;

-- 取り込み元の今の状態。消えたと完全な一覧で確かめられた項目は行ごと消す（墓標を置かない）。
-- 文書は原文を body に持つ。検索するのは knowledge の節で、節の連結から原文は戻さない。
create table source_item (
  id integer primary key autoincrement not null,
  connector_id integer not null references connector (id) on delete cascade,
  external_id text not null,
  kind text not null check (kind in ('pull_request', 'issue', 'document', 'requirements', 'design')),
  title text not null check (title <> ''),
  state text,
  url text,
  path text check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..'),
  body text,
  author_identity_id integer references person_identity (id) on delete set null,
  source_created_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', source_created_at) is source_created_at),
  source_updated_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at) is source_updated_at),
  -- PR はマージした時刻（マージせず閉じたなら閉じた時刻）、issue は閉じた時刻。開いているものと文書は null。
  closed_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) is closed_at),
  content_hash blob not null check (length(content_hash) = 32),
  metadata text not null default '{}' check (json_valid(metadata) and json_type(metadata) = 'object'),
  synced_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    check (strftime('%Y-%m-%dT%H:%M:%fZ', synced_at) is synced_at),
  unique (connector_id, external_id),
  check (
    case
      when kind in ('document', 'requirements', 'design') then path is not null and body is not null and state is null
        and closed_at is null
      else path is null and body is null and state in ('open', 'merged', 'closed') and (state = 'open') = (closed_at is null)
    end
  ),
  -- 上の CHECK は state が NULL だと式全体が NULL になって通る。closed_at との対もそのとき守られない。
  constraint source_item_state_required check (kind in ('document', 'requirements', 'design') or state is not null)
) strict;
create index source_item_listing on source_item (connector_id, kind, state, source_updated_at desc);

-- coding session、または GitHub の PR / issue 1 件ぶんの会話。
-- id は (project, origin, external_id) から決定的に作る uuid。同じ session を 2 回送っても行が増えない。
create table conversation (
  id text primary key not null,
  project_id integer not null references project (id) on delete cascade,
  source_item_id integer references source_item (id) on delete cascade,
  origin text not null check (origin in ('claude-code', 'codex', 'github')),
  external_id text not null,
  branch text,
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  unique (project_id, origin, external_id),
  check ((origin = 'github') = (source_item_id is not null))
) strict;
create index conversation_recent on conversation (project_id, started_at desc);

-- 1 発言 1 行。self は持ち主が打った発言、assistant は AI の最後の応答か AI レビュアー、bot は自動通知。
-- 大きすぎる発言は冒頭と末尾だけを残し、truncated と元の大きさ（UTF-8 のバイト数）を持つ。
create table message (
  -- seq は FTS5 の rowid。VACUUM で番号が変わらないよう、暗黙の rowid ではなく明示の integer primary key にする
  seq integer primary key not null,
  id text not null unique,
  conversation_id text not null references conversation (id) on delete cascade,
  external_id text not null,
  turn_id text,
  reply_to_id text references message (id) on delete set null,
  speaker_kind text not null check (speaker_kind in ('self', 'person', 'assistant', 'bot')),
  identity_id integer references person_identity (id) on delete set null,
  body text not null check (body <> ''),
  truncated integer not null default 0 check (truncated in (0, 1)),
  original_bytes integer not null check (original_bytes > 0),
  url text,
  sent_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) is sent_at),
  content_hash blob not null check (length(content_hash) = 32),
  -- 全文検索の索引に入れるか。coding session の AI の応答と自動通知は 0（判定は capture.ts / github.ts の indexesMessage）
  indexed integer not null check (indexed in (0, 1)),
  unique (conversation_id, external_id),
  check (truncated = 1 or original_bytes = length(cast(body as blob))),
  check (truncated = 0 or original_bytes > length(cast(body as blob)))
) strict;
create index message_order on message (conversation_id, sent_at);
create index message_by_identity on message (identity_id, sent_at desc) where identity_id is not null;
create index message_self on message (sent_at desc) where speaker_kind = 'self';

-- 全文検索の索引。rowid = message.seq。語は gleanery_terms()（server/src/text.ts の terms() を接続ごとに登録）で切る。
-- 関数を登録していない接続からの書き込みは no such function で失敗する（索引を黙って欠かさない）。
create virtual table message_fts using fts5(lexemes, content='', contentless_delete=1);
create trigger message_fts_ai after insert on message when new.indexed = 1 begin
  insert into message_fts (rowid, lexemes) values (new.seq, gleanery_terms(new.body));
end;
create trigger message_fts_ad after delete on message when old.indexed = 1 begin
  delete from message_fts where rowid = old.seq;
end;
create trigger message_fts_au after update of body, indexed on message begin
  delete from message_fts where rowid = old.seq and old.indexed = 1;
  insert into message_fts (rowid, lexemes) select new.seq, gleanery_terms(new.body) where new.indexed = 1;
end;

-- 発言に結んだファイル。自動記録は、編集したファイル（edit）と読んだ要件定義・設計書（read）を、触る前に持ち主が
-- 最後にした発言へ結ぶ。GitHub の同期は、レビューで指されたファイル（review）をそのレビューの発言へ結ぶ。
-- path は project のルートからの相対。
create table message_file (
  message_id text not null references message (id) on delete cascade,
  path text not null check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..'),
  action text not null check (action in ('edit', 'read', 'review')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  primary key (message_id, path, action)
) strict;
create index message_file_path on message_file (path);

-- 作業の現在地。trace が更新する。active / blocked / paused が「続きをやる」の候補。
create table work_item (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  source_key text not null,
  title text not null check (title <> ''),
  goal text not null check (goal <> ''),
  current text not null check (current <> ''),
  next text not null default '[]' check (json_valid(next) and json_type(next) = 'array'),
  status text not null check (status in ('active', 'blocked', 'paused', 'done', 'abandoned')),
  conversation_id text references conversation (id) on delete set null,
  updated_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is updated_at),
  unique (project_id, source_key)
) strict;
create index work_item_open on work_item (project_id, updated_at desc) where status in ('active', 'blocked', 'paused');

-- 検索する知識の単位。trace が会話から選んだ判断と、文書の節。
-- 覆した決定は消さない（消すと再提案される）。superseded にして後継を指す。
-- stance は種類と状態から決まる。「通ってはいけない道」だけを引くときの絞り込みに使う。
create table knowledge (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  source_item_id integer references source_item (id) on delete cascade,
  conversation_id text references conversation (id) on delete cascade,
  work_item_id integer references work_item (id) on delete set null,
  source_key text not null,
  kind text not null check (kind in ('decision', 'option', 'constraint', 'non_goal', 'dead_end', 'finding', 'debt',
                                     'verification', 'question', 'document')),
  status text,
  stance text not null generated always as (
    case
      when kind in ('constraint', 'non_goal', 'debt') then (case status when 'active' then 'dont' else 'neutral' end)
      when kind = 'dead_end' then 'dont'
      when kind = 'option' then (case status when 'chosen' then 'do' else 'dont' end)
      when kind = 'decision' then (case status when 'accepted' then 'do' when 'proposed' then 'neutral' else 'dont' end)
      when kind = 'verification' then (case status when 'failed' then 'dont' else 'neutral' end)
      else 'neutral'
    end
  ) stored,
  confidence text check (confidence in ('fact', 'inference', 'opinion')),
  decision_id integer references knowledge (id) on delete cascade,
  superseded_by_id integer references knowledge (id) on delete set null,
  heading text,
  body text not null check (body <> ''),
  reason text,
  confirmation text,
  command text,
  downsides text not null default '[]' check (json_valid(downsides) and json_type(downsides) = 'array'),
  refs text not null default '[]' check (json_valid(refs) and json_type(refs) = 'array'),
  occurred_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) is occurred_at),
  content_hash blob not null check (length(content_hash) = 32),
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
  check (case kind when 'option' then decision_id is not null when 'verification' then 1 else decision_id is null end),
  check ((kind = 'decision' and status = 'superseded') = (superseded_by_id is not null)),
  check (superseded_by_id is null or superseded_by_id <> id),
  check (confirmation is null or kind = 'decision'),
  check (command is null or kind = 'verification'),
  check (json_array_length(downsides) = 0 or kind = 'decision'),
  check (kind <> 'document' or work_item_id is null)
) strict;
create index knowledge_listing on knowledge (project_id, kind, status, occurred_at desc);
create index knowledge_work on knowledge (work_item_id) where work_item_id is not null;

-- 全文検索の索引。rowid = knowledge.id。列は見出し（h）と本文 + 理由（b）。検索は bm25(knowledge_fts, 3, 1)。
-- trace の見出しには作業の題が、文書の節の見出しには path と見出しの段が入る。
create virtual table knowledge_fts using fts5(h, b, content='', contentless_delete=1);
create trigger knowledge_fts_ai after insert on knowledge begin
  insert into knowledge_fts (rowid, h, b)
  values (new.id, gleanery_terms(coalesce(new.heading, '')), gleanery_terms(new.body || char(10) || coalesce(new.reason, '')));
end;
create trigger knowledge_fts_ad after delete on knowledge begin
  delete from knowledge_fts where rowid = old.id;
end;
create trigger knowledge_fts_au after update of heading, body, reason on knowledge begin
  delete from knowledge_fts where rowid = old.id;
  insert into knowledge_fts (rowid, h, b)
  values (new.id, gleanery_terms(coalesce(new.heading, '')), gleanery_terms(new.body || char(10) || coalesce(new.reason, '')));
end;

-- 判断とファイルの直接の関係。applies_to は編集の前に出す制約、evidence は根拠として挙げたファイル。
create table knowledge_file (
  knowledge_id integer not null references knowledge (id) on delete cascade,
  path text not null check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..'),
  role text not null check (role in ('applies_to', 'evidence')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  primary key (knowledge_id, path, role)
) strict;
create index knowledge_file_path on knowledge_file (path, role);

-- 自動記録（capture の接続）が書ける 3 つの view。server/src/sqlite.ts の authorizer が、capture にはこの view への
-- insert と、下の trigger の中の書き込みだけを許す。source_item_id・identity_id・reply_to_id・url は view に無いので、
-- GitHub の会話を作ることも、他人の身元を名乗ることもできない。会話の id は決定的に計算できるので、既存の会話へ
-- 発言を足すことは止めない（自動記録の経路が悪用された場合に残る面）。
create view capture_conversation as
  select id, project_id, origin, external_id, branch, started_at from conversation;
create trigger capture_conversation_insert instead of insert on capture_conversation begin
  insert into conversation (id, project_id, origin, external_id, branch, started_at)
  values (new.id, new.project_id, new.origin, new.external_id, new.branch, new.started_at)
  on conflict do nothing;
end;

create view capture_message as
  select id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes, sent_at, content_hash, indexed
  from message;
create trigger capture_message_insert instead of insert on capture_message begin
  insert into message (id, conversation_id, external_id, turn_id, speaker_kind, body, truncated, original_bytes,
                       sent_at, content_hash, indexed)
  values (new.id, new.conversation_id, new.external_id, new.turn_id, new.speaker_kind, new.body, new.truncated,
          new.original_bytes, new.sent_at, new.content_hash, new.indexed)
  on conflict do nothing;
end;

-- 触る前に持ち主が最後にした発言へ結ぶ。その発言がこの DB に無ければ（途中で別のプロジェクトへ移った session など）捨てる。
create view capture_message_file as select message_id, path, action from message_file;
create trigger capture_message_file_insert instead of insert on capture_message_file begin
  insert into message_file (message_id, path, action)
  select new.message_id, new.path, new.action where exists (select 1 from message where id = new.message_id)
  on conflict do nothing;
end;

pragma user_version = 1;
