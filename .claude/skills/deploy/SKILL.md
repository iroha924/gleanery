---
name: deploy
description: mitos のダッシュボードを Vercel へ、認証を Clerk へ出すときの手順と落とし穴。デプロイする・環境変数を入れる・ドメインや DNS を触る・本番の認証を設定するときに使う。踏むと気付きにくい失敗（bun の版が落ちる、ビルダーが TypeScript 7 で死ぬ、DNS の名前が二重になる、本番の user id が別）を先に潰す。アプリのコードを書く作業には使わない。
---

# mitos を出す

画面と API は Vercel の 1 プロジェクト `mitos`（チーム `hir4tas-projects`）、認証は Clerk。
本番は `https://mitos.iroh4.com`。DNS は Squarespace のまま使い、**ネームサーバーは移さない**
（apex で別のサイトが動いている）。

## 入口

```bash
vercel deploy            # preview
vercel deploy --prod     # 本番
vercel curl <URL>        # Deployment Protection 越しに叩く。素の curl は弾かれる
vercel inspect <URL>     # status と、関数がどのリージョンに出たか（λ ... [sin1]）
clerk deploy status      # Clerk の本番構築の進捗（dns / ssl / mail / oauth）
```

## ビルドで踏むもの

**`installCommand` を書かない。**上書きするとコンテナ内で**最も古い bun** が選ばれる
（公式に明記）。1.3.14 が選ばれて `bun.lock`（lockfileVersion 2）を読めずに落ちる。
自動検出なら `bun.lock` から新しい方を選ぶ。

**`buildCommand` は型検査を飛ばすために置いてある。**`@vercel/backends` が TypeScript 7 で
落ちる（`doTypeCheck` が `readFile` を読めない）。`buildCommand` があるだけで
`Typecheck skipped (Build Command is configured)` になる。tsc は pre-commit と
`bun run check`、本番ビルドは pre-push と CI の `bun run verify` が通しているので失うものは無い。

**手元で `vercel build` を試すときは `server/node_modules/typescript` を退ける。**
退けないと上と同じ所で落ちる。ビルドマシンは fresh clone なので影響しない。

**`server/src/server.ts` のファイル名と既定の export が入口。**外れると Hono として
認識されず、`server/` が丸ごと静的配信される（実測で `evals/` まで出た）。

## 環境変数

preview と production へ別々に入れる。**値をコマンドの引数に置かない** — シェル履歴と
プロセス一覧に残る。ファイルから流し込む。

```bash
vercel env add <秘密の名前> production --sensitive --force < <値だけを書いた一時ファイル>
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production --type config --force \
  < <値だけを書いた一時ファイル>
```

`NEXT_PUBLIC_` はブラウザへ公開されるため、Vercel は Secret 型を受け付けない。Clerk の公開鍵だけを
Config 型にし、残りは Secret 型にする。

入れるのは次の 9 つ。**`KNOWLEDGE_DB_URL`（管理鍵）は入れない** — 推論する層に
全部書ける鍵を持たせない境界がここで決まる（入れ忘れても `db.ts` が管理鍵へ落ちるのを弾く）。

```
KNOWLEDGE_DB_URL_RO  KNOWLEDGE_DB_URL_CFG  VOYAGE_API_KEY  OPENAI_API_KEY
CLERK_SECRET_KEY  CLERK_PUBLISHABLE_KEY  MITOS_ALLOWED_USER_ID  MITOS_ALLOWED_ORIGINS
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY   ← 画面のビルド用。これだけ NEXT_PUBLIC_ が要る
```

## Clerk の本番は別インスタンス

**ユーザーストアが別。**開発でサインインした user id は本番に存在しないので、本番で
サインアップしてから id を取り直す。**ここを忘れると、サインインは通るのに API が 401 を返す。**

```bash
clerk env pull --instance prod --file <一時ファイル>   # pk_live / sk_live
clerk users list --instance prod --json                # 本番の user id
```

OAuth も別で、本番は自前の GitHub / Google のクレデンシャルが要る（開発は Clerk の共有）。
`clerk deploy` は対話式なので人が叩く。

## DNS

**Squarespace の名前欄は相対名。**フルドメインを入れると `iroh4.com` が二重に付く
（実測: `clerk.mitos.iroh4.com.iroh4.com` にレコードができ、5 本とも引けなかった）。
`clerk.mitos` と書く。

**Vercel の CNAME はプロジェクト固有。**`76.76.21.21` の A レコードではなく、
`vercel domains verify <domain>` が返す値を使う。ドメインの割り当ては、**直近の本番
デプロイが失敗しているとできない。**

伝播とミスの切り分けは、権威サーバーへ直接聞く。

```bash
dig @nse1.squarespacedns.com +short clerk.mitos.iroh4.com CNAME
```

## 出したあとに確かめる

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mitos.iroh4.com        # 200（HTML 内の Next redirect でサインインへ）
curl -s -o /dev/null -w '%{http_code}\n' https://mitos.iroh4.com/now    # 200（deep link も同じ）
curl -s https://mitos.iroh4.com/api/now                                  # {"error":"未認証"}
```

**鍵なしで 401 が返ることまでを確認する。**500 なら環境変数が足りていない。
サインイン後にデータが出るかは、セッションを持つ人にしか確かめられない。
