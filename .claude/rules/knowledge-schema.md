---
paths:
  - "server/src/**"
  - "db/migrations/**"
---

# ナレッジの形

`node` 1 表に全種別を入れる。**分けない。**「認証で行き止まりになった話」は `dead_end` にも
棄却された案にも失敗した検証にもあるので、表を割るとベクトル索引も割れて 1 クエリで引けなくなる。

| 列 | 何を入れるか |
|---|---|
| `kind` | `event` / `decision` / `option` / `question` / `verification` / `boundary` / `utterance` / `doc` |
| `subkind` | `kind` の内訳。`option/rejected`、`verification/fail`、`doc/adr` など |
| `polarity` | `do` / `dont` / `na`。IR の取り込みだけ `polarityOf()`（`ingest.ts`）が導出する。ほかの 4 つの口は `na` を直に書く |
| `confidence` | `fact` / `inference` / `opinion`。`fact` は証拠が要る |

`kind` は enum ではなく text + check。**ドメイン知識の種別を後から足すための余地**で、
足すときは移行を書いて check を広げる（`20260908100000_doc_kind.sql` が例）。

## 種別を足したら、出口にも足す

**ここが今までいちばん漏れた場所。**入れただけでは AI に届かない。

- [ ] `server/src/search.ts` の `LABEL` に札を足す。**無札のまま再ランクへ渡すと意味を見分けられない**
      （実測: 札を足して recall@5 が 95% → 100%）
- [ ] `server/src/mcp.ts` の `kinds` enum と、その `describe` に足す
- [ ] `dashboard/src/routes/search.tsx` の `KINDS` に足す。**出ているのに絞れない**状態になる
- [ ] 既定の検索から外すなら `search()` の `clauses()` に条件を足し、**理由をコメントに残す**

**量の多い種別は既定から外す。**`utterance` の bot 定型文・`event/pr`・`doc` がそれで、
どれも「1 件の決定に対して周辺の説明が何十件も並ぶ」形をしている。
**入れる前と後で `node server/evals/retrieval.ts` を回して数字で決める**
（実測: `doc` を既定に入れると top1 が 80% → 35% に落ちた）。

## 極性は列で持つ

「触ると決めた」と「触らないと決めた」は埋め込み空間でほぼ同じ位置に来る。
**ベクトルで区別しようとしない。**`polarity` 列で絞る。

## 取り込み口を足すとき

既存の 5 つ（`ingest` / `github` / `linear` / `session` / `docs`）と同じ形にする。

- 1 つの取り込み元 = 1 つの `record`、その中の単位が `node`
- `content_hash` が一致したら埋め込みを取り直さない。**日次で回すので、ここが無いと費用が線形に増える**
- 埋め込みは**トランザクションの外**で取る。中で待つと開いたまま放置される
- 埋め込む文には**構造から文脈を前置する**（PR の題、文書の見出しの道）。LLM の推論は要らない
- **`mitos sync` に繋ぐ。**繋がないと人が手で叩いたときしか入らない

**上書きで編集される取り込み元は、消えたものを `deleted_at` で落とす。**
PR と会話は追記しかされないので要らないが、文書には要る（撤回した記述が引かれ続ける）。

## 移行を書くとき

`alter default privileges ... grant select ... to knowledge_ro` が**後から作った表にも効く**。
読ませたくない表を足したら `revoke select` を明示する（実測: `search_log` が RLS で 0 行に
なっていただけで、権限としては読めていた）。

**同じ罠が画面用ロールにもある。**`20260906180000_config_role_for_dashboard.sql:16` の
`alter default privileges ... grant select on tables to mitos_cfg` も後から作った表に効く。
**読み取りの既定が 2 つあるので、表を足したら両方について決める。**

**`mitos_cfg` に `record` と `node` への書き込みを与えない。**推論する層に書き込みを持たせない
境界がここで決まる。**grant を読んで判定しない** — `mitos_cfg` への grant は 6 本の migration に
散っていて、1 本だけ見ると成立しているように見える。確かめ方は `KNOWLEDGE_DB_URL_CFG` で繋いで
`insert into node` と `insert into record` がどちらも `permission denied for table ...` になること
（実測 2026-09-09）。
