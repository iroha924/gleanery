---
name: deploy
description: mitosのNext.jsとHonoをVercelへdeployし、Clerk本番認証、環境変数、custom domain、DNSを設定・検証する。previewやproduction反映を行うときに使う。アプリの実装だけなら使わない。
---

# mitosをVercelへ出す

## Triggers

- previewまたはproductionへdeployする
- Vercelの環境変数、domain、build失敗を扱う
- Clerk本番instance、OAuth、DNSを設定する

## Does not trigger

- `dashboard/`やHono routeを実装するだけの作業

画面とAPIはVercelの1 project `mitos`、認証はClerk、本番は`https://mitos.iroh4.com`である。DNSは
Squarespaceに残し、nameserverを移さない。

## コマンド

```bash
vercel deploy
vercel deploy --prod
vercel curl <URL>
vercel inspect <URL>
clerk deploy status --mode agent
```

## build

`vercel.json`に`installCommand`を足さない。Vercelの自動検出に任せないと古いbunが選ばれ、現在の
lockfileを読めない。`buildCommand`は`@vercel/backends`とTypeScript 7の非互換を避けるために置いて
あり、型検査は`bun run verify`で行う。

Honoの公開entrypointは`server/src/server.ts`のdefault exportで、rewriteは`/api/*`だけをこのserviceへ
送る。entrypointを外すとserviceが静的配信として扱われ、server配下が公開される。GitHubの取り込みは各PCの
`mitos sync`が行い、Vercelには置かない。

## 環境変数

previewとproductionへ別々に入れる。値を引数へ書かず、一時fileからstdinで渡す。

```bash
vercel env add <name> production --sensitive --force < <value-file>
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production --type config --force < <value-file>
```

必要な変数は次の8個で、`KNOWLEDGE_DB_URL`（owner）、`KNOWLEDGE_DB_URL_INGEST`、`KNOWLEDGE_DB_URL_CAPTURE`は
入れない。画面のAPIは読むだけで、書き込みの鍵を持たない。

```text
KNOWLEDGE_DB_URL_RO  VOYAGE_API_KEY  OPENAI_API_KEY
CLERK_SECRET_KEY  CLERK_PUBLISHABLE_KEY  MITOS_ALLOWED_USER_ID  MITOS_ALLOWED_ORIGINS
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
```

`NEXT_PUBLIC_`の公開鍵だけConfig型、残りはSecret型にする。`bun run db:roles`で鍵を作り直したら、
`KNOWLEDGE_DB_URL_RO`をpreviewとproductionの両方で入れ直してから再deployする。古い鍵のままのdeployは
DBへ繋がらない。

## ClerkとDNS

Clerkのproductionはdevelopmentとuser storeが別である。本番でsign upしてからuser idを取り直す。
Clerk CLIの操作では`clerk-cli` Skillも使う。

```bash
clerk env pull --instance prod --file <temporary-file>
clerk users list --instance prod --json
```

Squarespaceのrecord名は相対名なので`clerk.mitos`と書く。Vercelは固定A recordではなく
`vercel domains verify <domain>`が返すproject固有のCNAMEを使う。権威serverへ直接問い合わせて
反映を確認する。

## 検証

deploy前に`bun run verify`を通す。deploy後は`vercel inspect`で成功とregionを確認し、次を確認する。

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mitos.iroh4.com
curl -s -o /dev/null -w '%{http_code}\n' https://mitos.iroh4.com/sessions
curl -s https://mitos.iroh4.com/api/sessions
```

先頭2つは200、資格情報なしのAPIは401である。500なら環境変数不足を調べる。sign-in後に作業場所を1つ選び、
チャットが根拠付きで答えることと、`/sessions`に自動記録した会話が出ることを確かめる。
