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

入っている版と、確認済みの一次情報。**版を上げたときはここを取り直す。**

| 依存 | 版 | 規約に効く事実 |
|---|---|---|
| react | 19.3.0 | `forwardRef`不要、`<Context>`をproviderとして直接書ける、ref callbackがcleanupを返せる |
| babel-plugin-react-compiler | 1.0.0 | `compilationMode`既定`infer`。PascalCase / `use`接頭辞が最適化の条件 |
| @tanstack/react-query | 5.102.8 | `throwOnError`既定`false`、`retry`既定3、mutationのretryは0 |
| @tanstack/react-router | 1.170.38 | zod v4はアダプタ不要。`routeTree.gen.ts`はcommitする（公式FAQ） |
| typescript | 7.0.2 | **APIを持たない**のでtypescript-eslintが動かない。`strict`は既定で`true` |
| tailwindcss | 4.3.3 | `@theme`でCSS側に設定。`shadow-sm`等の意味がv3から変わっている |
| biome | 2.5.12 | a11yルール36本が全部recommended。`useReactCompiler`は**内部エラーで落ちる**（実測） |

- [React Compiler 1.0](https://react.dev/blog/2025/10/07/react-compiler-1)
- [preserve-manual-memoization](https://react.dev/reference/eslint-plugin-react-hooks/lints/preserve-manual-memoization)
- [TanStack Query - Queries](https://tanstack.com/query/latest/docs/framework/react/guides/queries)
- [TanStack Router - Search Params](https://tanstack.com/router/latest/docs/framework/react/guide/search-params)
- [Tailwind v4 Upgrade Guide](https://tailwindcss.com/docs/upgrade-guide)
- [Radix Accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility)

## 状態をどこへ置くか

上から順に当てはめ、最初に当たったところへ置く。

| 条件 | 置き場所 |
|---|---|
| URLで共有・ブックマークできるべきか | routeの`validateSearch` |
| サーバーから来たデータか | TanStack Query |
| 画面をまたいで保つ利用者の選択か | `localStorage` + Context（今は作業場所の選択だけ） |
| それ以外 | `useState` |

**storeを足さない。**zustand / jotaiは依存に無く、Contextが1つで足りている。

`localStorage`は読み書きの両方をtry/catchで囲む。失敗しても画面は動かす（プライベートウィンドウで
落ちる）。**失敗をUIへ出さない**のは、利用者が対処できないため。

## URLの状態

`validateSearch`にzodのschemaをそのまま渡す（**v4はアダプタ不要**。v3は`@tanstack/zod-adapter`が要った）。

- 既定値は`stripSearchParams`でURLから消す。`?page=1`を出さない
- 画面をまたいで保つものは`retainSearchParams`を**そのrouteに**付ける。rootに置くと、
  検索語やページ番号がチャットや会議の画面へ漏れる
- **middlewareの順は`stripSearchParams` → `retainSearchParams`。**逆にすると`retain`が`strip`の
  結果を後から書き戻し、既定値がURLから消えない（この順序は公式ドキュメントに記載が無く、実測で決めた）
- `Link`の`to`は文字列リテラルではなくroute参照を渡す。`from`を省くと絶対パスしか補完されない
- 相対移動は`useNavigate({ from: Route.fullPath })`
- routeを知らない共有componentは`useSearch({ strict: false })`

## Queryの作法

- 分岐は`isPending` → `isError` → 本体。`isLoading`は使わない（v5では`isPending && isFetching`の派生）
- バックグラウンド再取得の表示は`isFetching`。`isPending`と混ぜない
- `queryKey`は配列の先頭に概念名、続けて絞り込みの値。同じ概念に別の綴りを使わない
- `enabled`で止めるなら、型のほうも絞る。`as string`で通すと、止まっていない経路で壊れる
- `retry`は既定3で、`127.0.0.1`を叩くこの構成では失敗表示が最大7秒遅れる。4xxを再試行しない形にする
- `throwOnError: true`へ寄せるなら`QueryErrorResetBoundary`を必ず併記する（無いとErrorBoundaryを
  リセットしてもクエリがerrorのままで再試行できない）
- `useSuspenseQuery`は1コンポーネント内の複数クエリが直列になるので、この構成では採らない

## React Compilerの落とし穴

**「ビルドが通る」は「最適化された」の証拠にならない。**Compilerは Rules of React 違反を見つけると
黙ってそのコンポーネントを飛ばす。

- 依存配列が半端な`useMemo`が1つあると、`preserve-manual-memoization`により**そのコンポーネントの
  最適化ごと落ちる**
- **Biomeの`useReactCompiler`は内部エラーで落ちるので使えない**
  （実測: `dashboard/src/hooks/use-mobile.ts`で "derived from an internal Biome error"）
- 機械で拾う手段は`reactCompilerPreset({ logger })`。入っている版の型に`CompileSkipEvent`・
  `CompileErrorEvent`・`CompileDiagnosticEvent`があり（`babel-plugin-react-compiler/dist/index.d.ts`）、
  **飛ばされたコンポーネントを名前で取れる**。常用せず、疑ったときに検証用のbuildで回す
- `panicThreshold`でコンパイル失敗をbuildエラーへ上げられる。本番buildでは上げない
  （Rules of React違反のある1ファイルが全体のbuildを止める）
- 目で見る手段はReact DevToolsのバッジ
- ESLintの`eslint-plugin-react-hooks`は公式の推奨だが、TypeScript 7にAPIが無いため
  typescript-eslintが動かず、この構成では入れられない
- 一時的に外すなら`"use no memo"`。**恒久的な解にしない**（公式が debugging tool と明記）

## Tailwindとshadcn

- 色・間隔・角丸は`src/styles.css`の`@theme`で定義した意味のある名前から選ぶ。生のhexを書かない
- 条件付きのクラスは`cn()`。テンプレートリテラルで組み立てると、同じ分岐が別の書き方で複製される
- **クラスの順序は規約にしない。**公式ツールはPrettierプラグインだけで、このリポジトリはBiomeで
  整形している。Biomeの`useSortedClasses`はnurseryで`@theme`の値を知らないため、公式の順序と一致しない
- `components/ui/`はshadcnがコードとして配ったもので、編集禁止ではない。手を入れたら理由をコメントに残す
  （実例: `sidebar.tsx`はCookieからlocalStorageへ変えてある）
- 薄いラッパーを作らない。variantを足したいときは`cva`の定義側へ足す

## アクセシビリティ

Radixが引き受けるのはrole・focus・キーボードで、**テキストは引き受けない**。

- `input` / `textarea`には関連付けたlabelか`aria-label`
- アイコンだけのボタンには`aria-label`
- `Dialog`には`Title`と`Description`。視覚的に隠すなら`VisuallyHidden`、消すなら
  `aria-describedby={undefined}`を`Content`へ渡す
- 流れ込む領域には`aria-live`
- マウスだけで届く操作を作らない。`div`に`onClick`を付けるなら、その時点で`button`を使う

Biomeのa11yルール36本が全部recommendedで効いている。ただし`biome.json`が`components/ui`を
除外しているので、**Radixラッパーだけ素通りする**。そこを触るときは目で確かめる。

## テスト

画面のテストはVitest + Testing Library。**状態遷移を利用者から見える形で検査する。**

- roleとaccessible nameで引く（`getByRole("button", { name: "..." })`）。クラス名やtest idで引かない
- 最初に書くべきは、失敗と空の表示。成功だけのテストは、実際に壊れる面を守らない
- E2Eは最初から作らない。ブラウザ固有の挙動と見た目は実ブラウザで確かめる

## 境界

- `server/src`のMCP・CLI・hookを画面のbuildへ取り込まない
- 画面は同一originの`/api/*`だけを呼ぶ。**認証は無い**ので、tokenもCookieも付けない
- Honoのrouteは全部`/api/*`に置く。`server/src/server.ts`が持つ境界は3つで、
  `127.0.0.1`へのbind、Hostの完全一致、CSRF middlewareである。この3つより後にrouteを登録しない
  （`server/test/server.test.ts`が実際にHTTPを喋って検査する）
- CORS middlewareを入れない。許可を返さないことがcross-originの読み取りを止める手段そのものである
- 画面のAPIは`GLEANERY_DB_URL_RO`（読むだけ）で繋ぐ。書き込みの鍵を`server/src/http/`へ持ち込まない。
  取り込みを起動するrouteも作らない（`gleanery harvest`はCLIだけが持つ）
- 画面が持つ状態をDBへ書きたくなったら、browserのIndexedDBへ置く（実例: チャットの履歴
  `features/_chat/api/history.ts`）。**この境界が守っているのは、第三者が書いた文章をモデルへ読ませる
  プロセスを、永続データを書き換えるconfused deputyにしないことである。**injectionだけでなく、HTTP・
  依存・routeの欠陥が出ても被害を「読まれる」までに止める。認証が無く全要求が同じDB roleなので、
  clientが渡すIDは所有権の証明にならず「自分が作った行だけ」は強制できない（RLSでも同じroleは区別できない）
- 生成した答えを`knowledge`/`message`へ書き戻さない。検索と埋め込みが当たるのはこの2つで
  （`conversation`自体は対象外）、書き戻すと**自分の出力を自分の根拠に引く輪**ができる。
  別のstoreに置いて`search.ts`・埋め込み・lexemes・traceへ繋がなければ分離できる
- 作業場所を残すときは数値IDではなく`project.key`で持つ。DBを作り直すと同じIDが別の作業場所を指す
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
