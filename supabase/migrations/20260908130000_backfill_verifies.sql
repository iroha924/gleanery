-- 既にある「どの検証がどの決定を確かめたか」を辺にする。
--
-- **辺を書くようになったのは取り込みの側だけで、既にある記録は取り残された。**
-- `mitos sync` は IR を取り込み直さないので、辺はこの機能が入ってから
-- `mitos ingest` を叩いた記録にしか無い。結果、`mitos gaps` が
-- 「確かめ方を書いたのに検証が結び付いていない決定」として、
-- **実際には確かめ済みのものを 17 件中 14 件も並べていた**（実測）。
--
-- 事実は取り込んだ時点から `attrs->>'verifies'` に入っている。ここではそれを辺へ写すだけで、
-- 新しい情報は作らない。何度流しても同じ（on conflict do nothing）。
insert into public.relation (from_node, to_node, kind, source)
select v.id, d.id, 'verifies', 'record'
from public.node v
join public.node d
  on d.record_id = v.record_id
 and d.kind = 'decision'
 and d.key = v.attrs->>'verifies'
 and d.deleted_at is null
where v.kind = 'verification'
  and v.deleted_at is null
  and v.attrs->>'verifies' is not null
  and v.id <> d.id
on conflict (from_node, to_node, kind) do nothing;
