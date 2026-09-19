# AI開発環境の設計

Claude CodeとCodexが同じ不変条件を読み、作業に必要な手順だけを遅延loadするための配置記録。
規約そのものではなく、なぜ現在の配置にしたかと、変更時の評価方法を残す。

## 配置

| 種類 | 正本 | loadされる時点 |
|---|---|---|
| 全作業の不変条件 | `AGENTS.md` | 毎session |
| 人向け説明・command・setup | `README.md` | 必要時に読む |
| gleanery自身の開発手順 | `.agents/skills/` | repository内でSkillが選ばれた時 |
| Claude CodeのSkill discovery | `.claude/skills/`のsymlink | Skill metadataは起動時、本文は選択時 |
| plugin利用者へ配るSkill | `plugin/skills/` | pluginをinstallした環境 |
| installed Next.js固有の注意 | `dashboard/AGENTS.md` | dashboardで作業する時 |
| 必須の静的検査 | Lefthookと`bun run verify:ai` | commit、push、CI |

Claude Codeは`CLAUDE.md`の`@AGENTS.md`で共通規約を読む。import先を分割しても起動時contextは減らない
ため、rootは短くし、複数手順をSkillへ移した。

repo Skillの正本を`.agents/skills/`にしたのは、Codexがこの場所をrepository scopeとして探索するため。
Claude Codeもsymlink先のSkillを読めるので、`.claude/skills/`には同じdirectoryへのlinkだけを置く。
これらはgleanery自身を変更する開発者向けで、marketplaceのsourceは`plugin/`だけを指す。利用者向けの
`plugin/skills/`とは正本も配布経路も共有しない。

## 何をどこへ移したか

| 元の内容 | 分類 | 現在の場所 |
|---|---|---|
| runtime、権限、画面とHonoの境界 | 常時必要 | `AGENTS.md` |
| setup、鍵、全command、新しいPC | 人向け | `README.md` |
| MCP bundle、manifest version、到達確認 | 手順 | `plugin-release` Skill |
| 画面（Vite + React）、Honoの実装規約 | 手順 | `next-hono` Skill |
| DB schema、role、埋め込みと索引、知識の種類、取り込み | 手順 | `knowledge-schema` Skill |
| plugin review Agent固有の配布と解決 | 手順 | `plugin-agent-authoring` Skill |
| 対になる出口と、それを守る検査 | 配置の根拠 | このdocument |

Skill・Agent・ruleを作る一般手順はrepositoryに複製しない。Claude Codeではuser scopeの`docs-author`、
Codexでは組み込みの`skill-creator`を使う。

## Agentを増やさなかった理由

通常の探索と実装は組み込みのexplorer / workerで足りる。repository固有Agentを増やしても、同じ役割の
選択肢と保守箇所が増えるだけである。独立contextと固定modelが結果を変えるreviewは既に
`plugin/agents/`に分離されているため、今回は新しいAgentを追加せず、そのfrontmatterを
`verify:ai`の検査対象にした。

## 対になる出口

同じ値や判断が2箇所以上に写っている場所。片方だけ直しても、もう片方が動いてしまうので気付けない。
列挙できる対は検査で止め、集合にならない対は同じ関数を通して写しそのものを無くす。

| 片側 | 対 | 守り |
|---|---|---|
| `db/schema.sql`のCHECK（知識の種類と状態、話者、出自、ファイルの操作） | `server/src/knowledge.ts`の定数 | `scripts/check-pairs.mjs` |
| 同期が承認を判定する成果物のpath（`ARTIFACT_PATH`） | 画面の成果物の種別 | `scripts/check-pairs.mjs` |
| 表示の状態の印（`server/src/panel.ts`の`MARKS`） | review Skillの台帳の凡例と「形」の例の台帳の表の状態のセル（印の字はこの2か所だけに書き、注記の中には書かない） | `scripts/check-pairs.mjs` |
| `plugin/agents/`の各レビュアーの本文がuntrustedとして名指しする列挙 | 同じディレクトリの他の全定義（ちょうど1回書き、最小集合を含む。超過は可） | `scripts/check-pairs.mjs` |
| 例外の理由の文（CLI、自動記録、MCP、画面のチャット、音声のログ） | 同じ失敗を別の出口で出す文 | 同じ`server/src/text.ts`の`reason`を通す |
| 自動記録を送れていない判定（sessionの開始時の警告） | `gleanery doctor`の「自動記録」の行 | 同じ`server/src/capture.ts`の`readState().stuck`を通す |
| CLIの`USAGE` | READMEのCLI一覧 | `scripts/check-pairs.mjs`が書き出す |
| schemaのrevision | `server/src/db.ts`の`SCHEMA_REVISION`、`db/migrations`の最後の番号 | `server/test/db.test.ts`、`server/test/migrate.test.ts` |
| Claude plugin manifestのversion | Codex plugin manifestとmarketplaceのversion | `scripts/check-mcp-version.mjs` |
| 明示起動Skillの`disable-model-invocation` | Codexの`agents/openai.yaml` | `verify:ai` |
| reviewerの`effort`固定 | 同じ理由が要る`model`固定 | `verify:ai` |
| MCPの`recall`・`read` | 画面のチャットと全文表示 | 同じ`server/src/search.ts`の関数を通す |
| 自動記録が伏せる鍵の形 | traceが伏せる鍵の形 | 同じ`server/src/text.ts`の`mask`を通す |
| `gleanery check`の成果物検査（作業ツリー） | 文書同期の成果物検査（commit tree） | 同じ`server/src/artifacts.ts`の関数を通す |

2026-09-08にはMCP sourceを変更してbundleしただけのcommitが8回続き、versioned plugin cacheへ届いて
いなかった。このためplugin配布は注意書きだけでなくLefthookのversion検査でも止める。

## 公式仕様から採った判断

- Claude CodeはCLAUDE.mdを起動時contextへ入れるため、200行未満が目安。path ruleやSkillで条件付きにする
- Claude Opus 5は自己検証を既定で行うため、一般的な「最後に再検証せよ」は置かない
- Codexはrootからcurrent directoryまでのAGENTS.mdを読み、既定の合計上限は32 KiB
- Claude CodeとCodexはSkill本文を選択時に読む。descriptionがimplicit triggerの判定材料になる
- Codexの`.rules`はcommand権限制御用であり、architecture規約の置き場所にしない

一次情報:

- [Claude Code: memory](https://code.claude.com/docs/en/memory)
- [Claude Code: skills](https://code.claude.com/docs/en/skills)
- [Claude Opus 5 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [OpenAI: AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [OpenAI: Build skills](https://learn.chatgpt.com/docs/build-skills)

## 評価

`bun run verify:ai`はroot指示の行数・bytes、repository開発Skillのfrontmatter・trigger例・参照先・
symlink、plugin利用者へ配るSkillのmanifest入口とfrontmatter・参照先・明示起動の対（Claude Codeの
`disable-model-invocation`とCodexの`agents/openai.yaml`）・Codex用のCLIの呼び方、plugin Agentの必須設定を検査する。文言の一致は
評価しない。

新しいsessionのsmoke testでは、Hono endpoint、dashboard、DB schema、MCP、deployの各依頼に対し、
正しいSkill、禁止境界、実行する検証を答えられるかを見る。実装や外部変更はさせず、不要な質問や
subagent起動も失敗として扱う。

2026-09-11にClaude CodeとCodexの新しい読み取り専用sessionで上の5依頼とplugin Agent変更を確認し、
両方がrepository開発用Skillとplugin利用者向け配布物を区別して、正しいSkillと境界を選んだ。
