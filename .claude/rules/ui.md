---
paths:
  - "server/src/tui/**/*.ts"
  - "server/src/palette.ts"
---

# 端末の画面と CLI の出力

先に `tui` Skill を読む。

- JSX を使わず `createElement` で書く（src を Node の型剥がしで直接動かし、Node は JSX を読めない） <!-- invariant: create-element -->
- 色は `server/src/palette.ts`、記号は `server/src/tui/icons.ts` の名前で参照する。hex や記号を直に書かない <!-- invariant: palette-icons -->
- CLI の出力は `server/src/tui/view.ts` の部品で出す。中身は字下げし、締めの行だけを行頭に置く（外から来た文字が偽の行を作れない） <!-- invariant: view-parts -->
