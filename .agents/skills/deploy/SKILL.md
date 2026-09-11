---
name: deploy
description: mitosのNext.jsとHonoをVercelへdeployし、Clerk本番認証、環境変数、custom domain、DNSを設定・検証する。previewやproduction反映を行うときに使う。アプリの実装やGitHub連携の説明だけなら使わない。
---

# mitosをVercelへ出す

## Triggers

- previewまたはproductionへdeployする
- Vercelの環境変数、domain、build失敗を扱う
- Clerk本番instance、OAuth、DNSを設定する

## Does not trigger

- `dashboard/`やHono routeを実装するだけの作業
- GitHub連携によるpreview運用を説明するだけの作業

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

Honoのentrypointは`server/src/server.ts`のdefault exportである。外すとserviceが静的配信として扱われ、
server配下が公開される。

## 環境変数

previewとproductionへ別々に入れる。値を引数へ書かず、一時fileからstdinで渡す。

```bash
vercel env add <name> production --sensitive --force < <value-file>
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production --type config --force < <value-file>
```

必要な変数は次の9つだけで、`KNOWLEDGE_DB_URL`は入れない。

```text
KNOWLEDGE_DB_URL_RO  KNOWLEDGE_DB_URL_CFG  VOYAGE_API_KEY  OPENAI_API_KEY
CLERK_SECRET_KEY  CLERK_PUBLISHABLE_KEY  MITOS_ALLOWED_USER_ID  MITOS_ALLOWED_ORIGINS
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
```

`NEXT_PUBLIC_`の公開鍵だけConfig型、残りはSecret型にする。

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
curl -s -o /dev/null -w '%{http_code}\n' https://mitos.iroh4.com/now
curl -s https://mitos.iroh4.com/api/now
```

先頭2つは200、資格情報なしのAPIは401である。500なら環境変数不足を調べる。sign-in後のデータ表示は
sessionを持つbrowserで確認する。
