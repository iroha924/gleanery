-- 発言者の種別を書き直し、自動通知を検索から外す。
--
-- 取り込みが actor_kind を全部 'human' で書いていたため、Terraform の plan 結果・
-- デプロイプレビューの URL・カバレッジ表が人の発言と同じ土俵で上位を奪い合っていた。
-- 実測: ナレッジ 34,591 件のうち 14,852 件（43%）がこれ。
--
-- **消さずに墓標にする。**「いつ何をリリースしたか」を後で構造化して使う道を残すため。
-- 検索は deleted_at is null で絞っているので、これだけで根拠から外れる。
-- 戻すなら deleted_at を null に戻せばよい。
--
-- **AI のレビューは残す。**gemini-code-assist と coderabbitai の指摘には中身がある
-- （CI 的な定型は 5,300 件中 252 件だった）。落とすのは推論を含まない通知だけ。
-- **1 行に 1024 次元の埋め込み（12KB）がある。**34,464 行を無条件に更新すると
-- 400MB の書き換えになり、**当時の実行環境の statement_timeout（2 分）に当たった**（実測で落ちた）。
-- 値が変わる行だけに絞る。
set statement_timeout = '30min';

update public.node
   set actor_kind = case
     when actor_name in (
       'gemini-code-assist[bot]', 'coderabbitai[bot]', 'cursor[bot]',
       'claude[bot]', 'chatgpt-codex-connector[bot]', 'Copilot'
     ) then 'ai'
     when actor_name like '%[bot]' then 'ci'
     else 'human'
   end
 where actor_name is not null
   and actor_kind is distinct from (case
     when actor_name in (
       'gemini-code-assist[bot]', 'coderabbitai[bot]', 'cursor[bot]',
       'claude[bot]', 'chatgpt-codex-connector[bot]', 'Copilot'
     ) then 'ai'
     when actor_name like '%[bot]' then 'ci'
     else 'human'
   end);

update public.node
   set deleted_at = now()
 where actor_kind = 'ci' and deleted_at is null;
