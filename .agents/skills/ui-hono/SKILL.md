---
name: ui-hono
description: gleaneryの画面（Vite + React + TanStack Router）またはHono HTTP APIを変更する。画面、route、URLの状態、API入力、ローカルの境界を触るときに使う。MCP・CLIだけの変更やDB schemaの変更には使わない。
---

# 画面と Hono を変更する

## Triggers

- `dashboard/` の画面、routing、URLに持つ状態、データ取得を変更する
- `server/src/http/` または `server/src/server.ts` のAPIを変更する
- 画面とAPIの境界（静的配信、Host検査、CSRF）を変更する

## Does not trigger

- MCP・CLI・取り込みだけを変更する
- DB schemaやroleを変更する。その場合は`knowledge-schema`を使う
- 配布物やpluginのmanifestを変更する。その場合は`plugin-release`を使う

## 現行仕様を先に確認する

Vite、TanStack Router、TanStack Query、Honoは、入っている版の型定義か公式ドキュメントで現行の形を
確認する。記憶だけでAPIを選ばない。

## 境界

- `server/src`のMCP・CLI・hookを画面のbuildへ取り込まない
- 画面は同一originの`/api/*`だけを呼ぶ。**認証は無い**ので、tokenもCookieも付けない
- Honoのrouteは全部`/api/*`に置く。`server/src/server.ts`が持つ境界は3つで、
  `127.0.0.1`へのbind、Hostの完全一致、CSRF middlewareである。この3つより後にrouteを登録しない
  （`server/test/server.test.ts`が実際にHTTPを喋って検査する）
- CORS middlewareを入れない。許可を返さないことがcross-originの読み取りを止める手段そのものである
- 画面のAPIは`GLEANERY_DB_URL_RO`（読むだけ）で繋ぐ。書き込みの鍵を`server/src/http/`へ持ち込まない。
  取り込みを起動するrouteも作らない（`gleanery harvest`はCLIだけが持つ）
- AIが答えを組み立てる入口は作業場所で絞る。チャット（`/api/chat`）、会議の返答案（`/api/reply`）、全文
  （`/api/read`）は`projects`を必須にし、範囲の外の参照は「無い」と返す。範囲の無指定を「全部」と
  読まない — 別の仕事の決定が答えに混ざる。人が並べて見る一覧と検索（`/api/sessions`）は「すべて」を許し、
  各行に作業場所を出す
- セッション詳細の成果物は、そのsessionの`message_file`のpathと、同じ作業場所で同期された
  `source_item.path`が一致するものだけを返す。任意のpathや別の作業場所の文書を指定して本文を取れる
  入口を作らない

## 画面

完全にstaticなSPAである。サーバーで動く画面のcodeを書かない。置き場所とURLの扱いの正本は
`dashboard/AGENTS.md`にあり、要点は次の3つ。

- routeは`src/routes/`、機能の実装は`src/features/_名前/{api,model,ui}`。依存は`ui → model → api`だけ、
  `ui`を読める外部fileは`src/routes/`のroute entryだけとする（`bun run architecture`が検査する）
- URLに持つ状態はrouteの`validateSearch`で型と既定値を決める。`window.history.pushState()`を直接呼ばない
- サーバーから来たデータのキャッシュはTanStack Queryが持つ。routeのloaderへ移さない

3画面で同じ責務が現れるまで、共通の抽象を作らない。

## Hono

`server/src/server.ts`は境界のmiddlewareと`app.route("/api", ...)`と静的配信だけに保つ。機能別appは
`server/src/http/routes/`へ置き、methodとpathの直後にhandlerを書く。controller層を足さない。

静的資産の場所は`import.meta.url`から解決する。`serveStatic`の`root`はcwd起点なので、
別のdirectoryから起動されると配るものが変わる。`serveStatic`はSPAのfallbackを持たないので、
`/api/*`を先に登録したうえで最後に`index.html`を返すrouteを置く。

JSON、query、param、multipartは`@hono/zod-validator`とZodでhandlerより前に検査し、
`c.req.valid()`の値だけを使う。不正入力がDBや外部APIへ到達しないテストを置く。

Hono RPCは使わず、dashboardから`server/src`の型をimportしない。直接共有は独立したtsconfigと依存を
結合する。2026-09-11に最小構成で測ると、TypeScriptが読むfileは1,137から1,445、型のinstantiationは
312,715から672,220、メモリは266 MBから376 MBへ増えた。境界の正本はサーバーのZod schemaとし、画面側の型は
各画面の`api/`に1回だけ書く。

## 検証

入力境界のテスト、`bun run verify`、変更した画面の実ブラウザ動作を確認する。境界を変えたときは、
Hostが合わない要求が画面とAPIの両方で403になることも確かめる。
