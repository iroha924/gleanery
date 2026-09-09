---
paths:
  - "dashboard/**"
---

# ダッシュボードを触るとき

## 人の画面に足した絞り込みは、MCP にも足す

実測（2026-09-08）: `search.tsx` の `KINDS` に `utterance` があり、コメントには
「選ぶ手段が無いと二度と引けなくなるので、ここに置く」と書いてあった。一方 `mcp.ts` の
`kinds` は `z.enum` で 6 種しか受け付けず、`utterance` が無かった。**逃げ道が人にだけ用意されていた。**

触る場所の一覧は `.claude/rules/knowledge-schema.md` にある。あれは `server/src` と
`db/migrations` でしか自動ロードされないので、画面から先に触った回は載らない。ここから辿る。

## API に免除する経路を作らない

`/api/*` は全経路が Clerk の認証を通り、`MITOS_ALLOWED_USER_ID` と一致する 1 人しか通さない
（`server/src/server.ts`）。**新しい画面を足すときに「この 1 本だけ認証なし」を作らない。**

画面から API を叩く口は `dashboard/src/lib/api.ts` の 1 ファイルに閉じている。
`fetch` を直に書かず、そこの `authed()` を通す。**通さないと 401 になるだけなので気付けるが、
逆に「なぜか動かない」の原因がここだと分からない**ことのほうが多い。

**Cookie では通らない。**Authorization ヘッダが無い要求は API 側が先に落とす。
Clerk 自体は Cookie 経路も持っているので、そこに寄りかからず自分で落としている。

## ブラウザへ鍵を出さない

画面は HTTP しか知らない。設定画面が使う `mitos_cfg` ロールには **`record` と `node` への
書き込みを与えない**。削除機能などのために緩めると、「推論する層に書き込みを持たせない」境界が
ここから消える。

確かめ方は 1 つ。`KNOWLEDGE_DB_URL_CFG` で繋いで `insert into node` と `insert into record` が
どちらも `permission denied for table ...` になること（実測 2026-09-09）。**grant を読んで判定しない** —
`mitos_cfg` への grant は 6 本の migration に散っていて、1 本だけ見ると成立しているように見える。

表を足すときの扱いは `.claude/rules/knowledge-schema.md`「移行を書くとき」にある。
**そちらは `db/migrations/**` で載るので、migration を書く回はここを読まなくてよい。**

## Next.js へ移さない

`server/src` には入口が 4 つあり（`server.ts` / `mcp.ts` / `cli.ts` / `hook-check-path.ts`）、
ダッシュボードはそのうち 1 つでしかない（`d-stay-on-vite-react`）。
画面の都合で枠組みを替えると、残り 3 つが巻き込まれる。
