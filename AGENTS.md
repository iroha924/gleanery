# mitosで作業するとき

過去の作業から「なぜそうしたか」を貯め、Claude CodeとCodexから引けるようにする道具。
TypeScript / bun、PostgreSQL 18 + pgvector、Next.js、Honoを使う。埋め込みはVoyage、生成はOpenAI、
DBはNeon、画面とAPIはVercelで動く。

Claude Codeはrootの`CLAUDE.md`からこのfileをimportする。両AIに共通する常時規約はここだけを正本にし、
mitos自身の開発手順は`.agents/skills/`へ置く。`.claude/skills/`は同じSkillへのsymlinkである。
利用者へ配るSkillは`plugin/skills/`が別の正本であり、開発用Skillをpluginへ含めない。

## 実行境界

- DBの正本は`db/migrations/`と手書きSQLだけ。Prisma・Drizzleのschemaを別の正本として足さない
- ナレッジ本体の`record`と`node`を書けるのはCLIだけ。MCP、hook、HTTP APIへ管理鍵を渡さない
- MCPとhookは`knowledge_ro`、dashboard設定は`mitos_cfg`を使い、管理鍵へfallbackしない
- Next.jsは画面、Honoは全`/api/*`を担当する。Route HandlerやServer ActionへAPIを複製しない
- Honoの全APIはClerk認証middlewareを先に通す。`server/src/server.ts`のdefault exportをVercelの入口に保つ
- DBや生成APIの資格情報をNext.jsのserver codeとbrowserへ渡さない。画面は同一originの`/api/*`だけを呼ぶ
- HTML / Markdownの進捗fileを作らない。記録の正本はDB、現在地の表示はdashboardの`/now`

## 変更時の不変条件

- 人向けとAI向けの出口は別々に動かす。CLIやdashboardの成功をMCP応答の成功とみなさない
- 同じ値・分類・判断を変更したら`rg`で全参照を引き、対になる出口を探す。列挙できる対は検査へ足す
- 新しい取り込み元は`mitos sync`にも接続する。手動commandだけを追加して完了にしない
- plugin配布物を変更したらbundleと3 manifestのversion更新を同じcommitに含める
- 新しい外部入力はsystem境界で検査する。資格情報を追跡file、command引数、logへ書かない

## 作業別Skill

該当する作業では、実装前に次のSkillを最後まで読む。

- Next.js、Hono、Clerk、画面のAPI通信: `next-hono`
- migration、role、RLS、node kind、取り込み: `knowledge-schema`
- MCP、CLI、hook、plugin Skill・Agentの配布: `plugin-release`
- `plugin/agents/`とreview Agent: `plugin-agent-authoring`
- Vercel、Clerk本番、環境変数、domain、DNS: `deploy`

Skill・Agent・rule自体を新規作成するときは、Claude Codeでは既存の`docs-author`、Codexでは組み込みの
`skill-creator`を使う。一般的なexplorer / workerと重なるrepo Agentは作らず、独立contextや固定modelが
結果を変える専門検査だけをAgentにする。

## branchとPR

PRの要否はfile数ではなく影響面で決める。次をすべて満たす変更はmainへ直接入れてよい。

- 本番の実行時動作、データ、認証、secret、build・deploy、利用者向けplugin配布物を変えない
- 1 commitのrevertで戻せる
- commit前にdiffを最初から最後まで読み、対象に応じた検査を通した

例は文書、repository開発用の`.agents/skills/`・`.claude/`、test・evalの追加、意図した実行時動作を
変えない内部整理である。AIの読込経路を変えた場合は`verify:ai`に加えClaude CodeとCodexの新しい
sessionで確認する。

dashboard・Honoの実行時動作、DB migration・権限・データ変換、認証・secret、依存・build・CI・
Vercel設定、`plugin/skills/`・`plugin/agents/`・MCP・CLIを変える場合はPRを使う。Previewでの確認が
必要な変更と、影響範囲を即答できない変更もPRへ寄せる。

## 最小command索引

```bash
bun run setup       # server / dashboardの依存とLefthookを固定lockfileから入れる
bun run dev         # Hono + Next.js。TTYが要るため前面でだけ実行する
bun run verify      # lint、architecture、型、AI設定、test、Next.js production build
bun run verify:ai   # AGENTS、repository開発Skill、plugin Agentの静的検査
bun run bundle      # MCP、CLI、hookのplugin配布物を更新する
```

個別command、setup、運用、障害対応はREADMEを読む。pre-commitは変更対象の軽い検査、pre-pushとCIは
`bun run verify`を実行する。

## 外へ出す文章

PRは`.github/pull_request_template.md`、issueは`.github/ISSUE_TEMPLATE/`を先に読み、埋まらない節を
削除する。確認できない事実を補わない。PRとissueの本文はそのままナレッジへ取り込まれる。

## 参照先

- `README.md`: 全体像、DB、setup、全command、新しいPC、Vercel運用、troubleshooting
- `dashboard/AGENTS.md`: installed Next.js版が生成した規約
- `plugin/skills/trace/SKILL.md`: 記録を作る契約
- `plugin/skills/review/SKILL.md`: reviewの実行と担当分け
