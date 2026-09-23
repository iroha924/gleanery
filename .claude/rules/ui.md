---
paths:
  - "server/src/tui/**/*.ts"
  - "server/src/palette.ts"
---

# 端末の画面と CLI の出力を触るとき

**判断の基準はここに無い。**手順とバージョン依存の知識は `tui` Skill にある。先にそれを読む。

このファイルが言うのは、読む前に知っておくべき 3 つだけである。

- JSX を使わず `createElement` で書く。この repository は Node の型剥がしで src を直接動かし、Node は JSX を読めない <!-- invariant: create-element -->
- 色は `server/src/palette.ts` の名前で、記号は `server/src/tui/icons.ts` の名前で参照する。hex や記号を画面のコードに直に書かない <!-- invariant: palette-icons -->
- CLI の出力は `server/src/tui/view.ts` の部品で出す。中身は字下げし、締めの行だけを行頭に置く（外から来た文字に偽の行を作らせない） <!-- invariant: view-parts -->
