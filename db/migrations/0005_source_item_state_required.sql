-- PR・issue の行で state が NULL のとき、上の CHECK は式全体が NULL になるので通ってしまう。
-- knowledge の status と同じく NULL を明示的に拒む。当てる前の確認は knowledge-schema の Skill にある。
alter table gleanery.source_item
  add constraint source_item_state_required
  check (kind in ('document', 'requirements', 'design') or state is not null);
