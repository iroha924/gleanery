-- PR・issue の行で state が NULL のとき、source_item の CHECK は式全体が NULL になるので通る。
-- 同じ分岐の (state = 'open') = (closed_at is null) も、そのとき守られない。NULL を別に拒む。
alter table gleanery.source_item
  add constraint source_item_state_required
  check (kind in ('document', 'requirements', 'design') or state is not null);
