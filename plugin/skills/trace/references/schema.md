# IR のフィールド定義

## Contents

- 全体の形
- meta
- background
- 更新される 3 つ（current / next / openQuestions）
- events
- decisions
- verification
- links
- glossary
- evidence の書き方

正本は `lib/ir.mjs` の `validate()`。ここと食い違ったら実装が正しい。

## 全体の形

```json
{
  "schema": "progress/1",
  "meta": {}, "background": {},
  "current": {}, "next": [], "openQuestions": [],
  "events": [], "decisions": [], "verification": [],
  "links": { "issues": [], "prs": [], "commits": [], "files": [] },
  "glossary": []
}
```

**id はすべて `[a-z0-9][a-z0-9-]*` で、意味のある語にする。**連番や UUID にしない。
記録全体で重複させず、一度使った id は再利用しない（削除した要素の id も戻さない）。

## meta

| 欄 | 必須 | 内容 |
|---|---|---|
| `id` | ○ | ファイル名になる。`invoice-pdf-export` のように内容が分かる語 |
| `title` | ○ | 何の作業かが 1 行で分かる題 |
| `status` | ○ | `planning` / `in-progress` / `blocked` / `paused` / `done` |
| `repo` | | 保管先のディレクトリ名になる |
| `branch` | | 記録した時点のブランチ |
| `created` / `updated` | ○ | ISO 8601。オフセット付きで書く |
| `hosts` | | 記録に関わったホスト。`claude-code` / `codex` |

## background

| 欄 | 必須 | 内容 |
|---|---|---|
| `problem` | ○ | **なぜこの作業が必要になったか。**症状ではなく、放置すると誰が困るか |
| `goal` | ○ | **達成を測れる形で。**「動くようにする」ではなく観測できる条件 |
| `constraints` | | 変えてはいけないもの。理由もその場に書く |
| `nonGoals` | 推奨 | やらないこと。空だと警告。境界が無いと再開した側が範囲を広げる |

## 更新される 3 つ

**上書きしてよいのはこの 3 つだけ。**

`current` — `{ at, text, phases[] }`。`phases[]` は `{ id, label, state }` で、
`state` は `done` / `doing` / `blocked` / `todo`。工程バーになる。
**`current.text` を変えたら、変わった事実を `events` に `state_transition` として落とす。**
落とさないと「いつ・なぜ変わったか」が消える。

`next` — `[{ text, who }]`。`who` は `human` / `ai`。次のセッションが最初に読む欄。

`openQuestions` — `[{ id, at, q, who, when, blocking }]`。
`when` は `now`（いま答えが要る）/ `during-implementation`（実装中に解ける）/ `out-of-scope`（この作業の外）。
`blocking` が真のものは、再開時の要約で先頭に出る。**空なら節ごと描画されない**ので、
埋めるものが無ければ空配列でよい。

## events

`[{ id, at, kind, text, confidence, evidence[], phase }]`

| `kind` | 何を入れるか |
|---|---|
| `work` | 進んだこと。**手順の実況ではなく、状態が変わった単位で** |
| `finding` | 開発中に判明した重要事項。仕様の誤解、環境の癖、想定外の依存 |
| `dead_end` | 試して駄目だった道。**次の人が同じ道を通らないための欄** |
| `debt` | **意図して残した負債。**後任には単なる欠陥に見えるものを、意図だと明示する |
| `state_transition` | `current` が変わった事実。何から何へ、なぜ |

`confidence` は `fact` / `inference` / `opinion`。
**`fact` は `evidence` が 1 件以上ないと検証を通らない。**根拠を出せないなら `inference` にする。
省略したときは印が付かない（`fact` を名乗ったことにはならない）。

## decisions

`[{ id, at, status, context, decision, options[], consequences[], confirmation, evidence[], supersededBy }]`

| 欄 | 必須 | 内容 |
|---|---|---|
| `status` | ○ | `proposed` / `accepted` / `rejected` / `superseded` |
| `context` | ○ | そのとき働いていた力。技術・期日・人・組織。**中立な言葉で** |
| `decision` | ○ | 何を決めたか。能動態の完全な文で |
| `options` | ○ | `[{ option, chosen, whyNot }]`。**採った案に `chosen: true`、それ以外に `whyNot` が要る** |
| `consequences` | ○ | `[{ text, good }]`。**良いものだけだと警告**。受け入れた不利な点を `good: false` で |
| `confirmation` | ○ | **この決定が守られていることをどう確かめるか。**観測できる形で書く |
| `supersededBy` | status が superseded なら○ | 後続の決定の id |

**覆した決定を消さない。**`superseded` にして `supersededBy` を指す。消すと「なぜ変えたか」が失われ、
再開した側が元の案を再提案する。

**参照は記録をまたげる。**同じ記録の中なら `d-xxx`、別の記録なら `<記録の id>#d-xxx`。
またげないと「3 ヶ月前の別作業の決定をいま覆した」が書けない。
同じ記録を指しているのにその id が無ければ検査で落ちる（壊れた参照）。

## verification

`[{ id, at, what, cmd, result, output, evidence[], verifies, note, whyNotRun }]`

**`evidence` と `verifies` は散文だけに書かない。**この一覧に無いと、コマンドを持たない検証を書こうとした書き手は証跡の置き場を見つけられず、無い欄を発明する（実測: `how` と書いて 8 件弾かれた）。

`verifies` に**どの決定を確かめたか**を書く（`d-xxx`、別の記録なら `<記録の id>#d-xxx`）。
これが無いと「守ると決めたのに一度も確かめていない決定」を引けない。
確かめ方（`confirmation`）を書いた `accepted` な決定に対応する検証が無いと警告が出る。

`result` は `pass` / `fail` / `not-run`。
`not-run` 以外は **`cmd` か `evidence` のどちらかが必須**（「通ったはず」と「通った」を区別するため）。
**検証はコマンドとは限らない。**別のエージェントへのレビュー依頼、ブラウザでの目視、
人による確認はどれも実在する検証なので、レポートやログのパスを `evidence` に入れる。
**`cmd` には実行できるものだけを書く。**生成物では `\`` で囲んで出るので、
「python3 で〜を検査」のような散文を入れると、読み手がコピーして空振りする。
手順を説明したいなら `what` に書く。
`not-run` は `whyNotRun` が必須（環境が無い、別 OS が要る、次の実行が来月、など）。
**実行していないものを書かないのではなく、実行していないと書く。**

## links

```json
"issues": [{ "key": "#412", "title": "", "state": "open", "url": "",
             "fetched": true, "blockedBy": ["#405"], "parent": "#398" }]
"prs":    [{ "number": 421, "title": "", "state": "MERGED", "url": "", "branch": "" }]
"commits":[{ "sha": "a91f3c2", "subject": "" }]
"files":  ["app/workers/invoice_pdf_worker.rb"]
```

`fetched` は真偽値が必須。**取れなかったときに黙って空にせず、`false` にして key と url を残す。**
`blockedBy` は依存図の辺になる（左が先、矢印の先は元が終わるまで進めない）。

## glossary

`[{ term, meaning }]`。前提を知らない読み手が最初に詰まる語だけを入れる。
**コードを読めば分かることは書かない**（関数名、ファイルの場所）。書くのは、
その組織・その業務でしか通じない語。

## evidence の書き方

`[{ kind, ref, note, exit }]`

| `kind` | `ref` に入れるもの |
|---|---|
| `command` | 実行したコマンド。`exit` に終了コード |
| `commit` | コミットの SHA |
| `file` | `path/to/file.rb:88` の形 |
| `url` | 参照した URL |
| `issue` | issue のキー |

**全文を貼らない。**指し先だけを置き、実体は必要になったときに読む。
記録が肥大すると、拾われる確率そのものが下がる。
