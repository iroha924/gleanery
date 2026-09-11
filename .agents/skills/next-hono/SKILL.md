---
name: next-hono
description: mitosのNext.jsダッシュボードまたはHono HTTP APIを変更する。画面、route、Clerk認証、API入力、Vercel service境界を触るときに使う。MCP・CLIだけの変更やデプロイ作業には使わない。
---

# Next.js と Hono を変更する

## Triggers

- `dashboard/` の画面、routing、データ取得、Clerk統合を変更する
- `server/src/http/` または `server/src/server.ts` のAPIを変更する
- Next.jsとHonoのservice境界を変更する

## Does not trigger

- MCP・CLI・取り込みだけを変更する
- Vercelへの反映や環境変数の設定だけを行う。その場合は`deploy`を使う
- DB schemaやroleを変更する。その場合は`knowledge-schema`を使う

## 現行仕様を先に確認する

Next.jsは `dashboard/node_modules/next/dist/docs/` の対象ガイドを読む。Clerkなど外部依存は、入っている
版の型定義か公式ドキュメントで現行の形を確認する。記憶だけでAPIを選ばない。

## 境界

- `server/src`のMCP・CLI・hookをNext.js buildへ取り込まない
- 画面は同一originの`/api/*`だけを呼び、共有認証は`dashboard/src/lib/api-client.ts`を使う
- `proxy.ts`はClerk情報をServer Componentへ渡す入口で、認可の正本ではない
- browserが呼ぶ`/api/*`はClerk session tokenで守る。外部webhookは個別pathに分け、raw bodyの署名を
  handlerの入口で検証する。公開例外を汎用middlewareやprefixへ広げない

## Next.js

PageとLayoutはServer Componentで始める。状態、event、browser API、Clerkのbrowser tokenが必要な
最小境界だけをClient Componentにする。内部遷移は`next/link`、同じ画面の検索条件だけをURLへ残す
場合はnative History APIを使う。

画面固有の実装はroute隣接の`_画面名/{ui,model,api}`へ置く。依存は`ui → model → api`だけ、
private folderの`ui`を読める外部fileは隣接するroute entryだけとする。3画面で同じ責務が現れるまで
`features`、`entities`、`widgets`や共通抽象を作らない。`bun run architecture`が境界を検査する。

## Hono

`server/src/server.ts`は認証middlewareと`app.route("/api", ...)`だけに保つ。機能別appは
`server/src/http/routes/`へ置き、methodとpathの直後にhandlerを書く。controller層を足さない。

JSON、query、param、multipartは`@hono/zod-validator`とZodでhandlerより前に検査し、
`c.req.valid()`の値だけを使う。不正入力がDBや外部APIへ到達しないテストを置く。

Hono RPCは使わず、dashboardから`server/src`の型をimportしない。直接共有は独立したtsconfigと依存を
結合し、実測で型検査のinstantiationとメモリが増えた。詳細はREADME「API の置き方」。

## 検証

入力境界のテスト、`bun run verify`、変更した画面の実ブラウザ動作を確認する。認証変更では、少なくとも
資格情報なしの`/api/*`が401になることも確かめる。
