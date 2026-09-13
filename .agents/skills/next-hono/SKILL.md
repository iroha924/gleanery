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
- Honoのrouteは全部`/api/*`に置き、Clerkのsession tokenと`MITOS_ALLOWED_USER_ID`の一致を先に通す。
  公開の例外を作らない
- 画面のAPIは`KNOWLEDGE_DB_URL_RO`（読むだけ）で繋ぐ。書き込みの鍵を`server/src/http/`へ持ち込まない
- AIが答えを組み立てる入口は作業場所で絞る。チャット（`/api/chat`）、会議の返答案（`/api/reply`）、全文
  （`/api/read`）は`projects`を必須にし、範囲の外の参照は「無い」と返す。範囲の無指定を「全部」と
  読まない — 別の仕事の決定が答えに混ざる。人が並べて見る一覧と検索（`/api/sessions`）は「すべて」を許し、
  各行に作業場所を出す
- セッション詳細の成果物は、そのsessionの`message_file`のpathと、同じ作業場所で同期された
  `source_item.path`が一致するものだけを返す。任意のpathや別の作業場所の文書を指定して本文を取れる
  入口を作らない

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
結合する。2026-09-11に最小構成で測ると、TypeScriptが読むfileは1,137から1,445、型のinstantiationは
312,715から672,220、メモリは266 MBから376 MBへ増えた。境界の正本はサーバーのZod schemaとし、画面側の型は
各画面の`api/`に1回だけ書く。

## 検証

入力境界のテスト、`bun run verify`、変更した画面の実ブラウザ動作を確認する。認証変更では、少なくとも
資格情報なしの`/api/*`が401になることも確かめる。
