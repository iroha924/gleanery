---
paths:
  - "dashboard/src/**/*.ts"
  - "dashboard/src/**/*.tsx"
  - "dashboard/src/**/*.css"
  - "dashboard/*.ts"
  - "dashboard/index.html"
---

# 画面を触るとき

**判断の基準はここに無い。**不変条件は `dashboard/AGENTS.md`、版依存の知識と手順は `ui-hono` Skill。
先にその 2 つを読む。

このファイルが言うのは、読む前に知っておくべき 3 つだけである。

- `dashboard/src/routeTree.gen.ts` は生成物。手で編集せず、`git` では追跡する
- `dashboard/src/components/ui/` は shadcn が配ったコードで、`biome.json` が lint と format から
  除外している。触ったら目で確かめる
- 機械で判定できることは `bun run architecture` が見る（層の向き、route entry の import、
  `ui` / `model` からの共有 API 直呼び）。**落ちたら書き方を変える。検査を緩めない**
