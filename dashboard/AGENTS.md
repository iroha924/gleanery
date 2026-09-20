# dashboard を触るとき

完全に静的な SPA である。**サーバーで動くコードは 1 行も無い。**`vite build` が出す `dist/` を、
`server/src/server.ts` の Hono が `/api/*` と同じ origin で配る。

SSR、RSC、Server Actions、middleware、route handler を持ち込まない。`"use server"` は書かない。
`src/components/ui/` に残る `"use client"` は shadcn を取り込んだときの名残で、Vite では無視される。

## 置き場所

```
src/routes/      TanStack Router の file-based route。file 名がそのまま path になる
src/features/    機能ごとの module。api / model / ui の 3 層だけを置く
src/components/  画面をまたいで使うもの（ui/ は shadcn）
src/lib/         API の呼び出しと、画面をまたぐ状態
```

**機能の module を `src/routes/` の下に置かない。**`_` で始まる名前は TanStack Router では
pathless layout route の記法で、`routesDirectory` の下にあると generator が route として扱い、
`createFileRoute` の骨組みを書き込んでファイルを壊す。

依存の向きは `ui → model → api` の一方向だけ。`src/routes/` の route entry だけが、
module の `ui` を参照できる（`scripts/check-dashboard-boundaries.mjs` が検査する）。

`src/routeTree.gen.ts` は生成物だが **git 管理下に置く**。実行時に読まれるソースであって
一時キャッシュではない。手で編集しない。

## URL が状態の正本

画面の状態を URL に持つものは、route の `validateSearch` で型と既定値を決める。
`zod` をそのまま渡せる（v4 はアダプタ不要）。

- 既定値は `stripSearchParams` で URL から消す。`?page=1` を出さない
- 画面をまたいで保つものは `retainSearchParams` を**その route に**付ける。root に置くと、
  検索語やページ番号がチャットや会議の画面へ漏れる
- middleware の順は `stripSearchParams` → `retainSearchParams`。逆にすると `retain` が
  `strip` の結果を後から書き戻し、既定値が URL から消えない
- `window.history.pushState()` を直接呼ばない。URL だけ進んで画面が再評価されない
- 検索の状態を zustand や jotai のような store に持たせない

## API

同一 origin の `/api/*` を叩く。**認証は無い。**トークンも Cookie も付けない。
dev は Vite の proxy が `127.0.0.1:4924` へ流す。**`changeOrigin` を立てない** —
ブラウザの Origin と Hono が見る Host が食い違い、CSRF の検査に弾かれる。

サーバーから来たデータのキャッシュは TanStack Query が持つ。route の loader へ移さない。
チャットの SSE と会議の音声アップロードは loader に乗せない。

`@/lib/api` と `@/lib/api-client` を触るのは feature の `api/` 層だけにする。`ui` と `model` から
直に呼ぶと、失敗の扱いとエラー文がその画面だけ feature の外で決まる。

## 失敗の出し方

`useQuery` は `isPending` → `isError` → 本体の順で分岐する。`isLoading` は使わない。
**4 つの状態（読み込み・空・失敗・成功）を全部決めてから画面を書く。**どれかを書き忘れると、
そのぶんだけ利用者には何も起きない画面になる（実測: 作業場所の取得が失敗すると永遠に「読み込み中…」だった）。

- 例外の文字列をそのまま画面へ出さない。`String(error)` は `Error: /api/... が 500` を利用者に見せる
- 本文を出す領域へ失敗を流し込まない。読み手が本文かエラーかを区別できない
- 黙って捨てる（`.catch(() => {})`）のは、利用者が気付かなくてよい失敗だけにし、理由をコードに書く

## React Compiler

`babel-plugin-react-compiler` が有効で、`compilationMode` は既定の `infer`。
**コンポーネントは PascalCase、フックは `use` 接頭辞にする** — 命名の好みではなく、
これが最適化の対象になる条件である。

新しく書くコードで `useMemo` / `useCallback` / `memo` を書かない。既にあるものは消さない
（消すとコンパイル結果が変わる。React 公式が「消すならテストしてから」と書いている）。
**依存配列を半端に書くと、そのコンポーネントの最適化ごと落ちる**が、ビルドは通るので気付けない。

## 見た目と操作

- 色は `src/styles.css` の意味で選ぶ。`do` / `dont` は**判断の極性**専用で、システムの失敗には使わない
- 条件付きのクラスは `cn()` で書く。テンプレートリテラルで組み立てない
- `components/ui/` の Radix ラッパーは role・focus・キーボードを引き受けるが、**テキストは引き受けない**。
  アイコンだけのボタンには `aria-label`、Dialog には Title と Description を必ず書く
- 流れ込む領域（文字起こしなど）には `aria-live` を付ける
