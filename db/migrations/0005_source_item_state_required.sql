-- PR・issue の行で state が NULL のとき、source_item の CHECK は式全体が NULL になるので通る。
-- 同じ分岐の (state = 'open') = (closed_at is null) も、そのとき守られない。NULL を別に拒む。
--
-- **既存の行は検証しない（not valid）。**検証して 1 行でも当たると版が上がらず、以後 checkSchema が
-- MCP・CLI・画面を全部止める（owner の db:* だけが残る）。新しい行と更新される行は検査するので増えない。
-- 既存分を締めるには、0 件を確かめてから
-- `alter table gleanery.source_item validate constraint source_item_state_required;` を打つ。
alter table gleanery.source_item
  add constraint source_item_state_required
  check (kind in ('document', 'requirements', 'design') or state is not null) not valid;
