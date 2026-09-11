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

画面から API を叩くときは `dashboard/src/lib/api-client.ts` の `authed()` を通す。route-localへ移した
画面は `_画面名/api/` にその画面固有の通信を置き、共有の認証処理だけを `api-client.ts` から使う。
**通さないと 401 になるだけなので気付けるが、逆に「なぜか動かない」の原因がここだと分からない**
ことのほうが多い。

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

## Next.js と Hono の境界を保つ

共有する境界と過去の Vite 継続判断を上書きした記録は、Codex からも読める `AGENTS.md`
「ダッシュボードは Vercel でも動く」を正本とする。

`dashboard/AGENTS.md` は Next.js 自身が生成する現行版の注意書きである。画面を触る前に、対象の
API を `dashboard/node_modules/next/dist/docs/` で確認する。Page / Layout を初めから Client Component
にせず、状態・イベント・ブラウザ API・Clerk token が必要な最小の境界にだけ `"use client"` を置く。

認証は資源の近くで重ねる。`proxy.ts` は Clerk の情報を Server Component へ渡すために必要だが、
そこだけを認可の境界にしない。画面は `(dashboard)/layout.tsx`、データは Hono の全 `/api/*`
middleware が守る。静的ファイルと `/api/*` は Proxy の matcher から外す。

内部リンクは `next/link` を使う。検索条件など同じ Client Component の状態だけを URL に残す場合は、
RSC の再取得を増やさない native History API を使う。

画面を分けるときは route と同じ場所の private folder に `ui / model / api` を置く。依存は
`ui → model → api` だけを許し、隣接する `page.tsx` 以外から private folder を参照しない。
`bun run architecture` が pre-commit・pre-push・CI で検査する。全体像と配置例は README
「ダッシュボードの置き方」を正本とする。

Hono RPCは使わず、画面から `server/src` の型を直接importしない。独立serviceの型検査を結合した
実測と採否はREADME「API の置き方」が正本である。APIを足すときはサーバー側のZod schemaを境界の
正本にし、画面のroute-local `api` には、その画面が実際に使う応答型だけを置く。
