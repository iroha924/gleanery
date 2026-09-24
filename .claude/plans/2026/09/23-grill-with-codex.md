# grill-with-codex の Skill を作る

- 日付: 2026-09-23
- Codex との議論: 3 往復（session `01a0cdc0-7a09-7a20-ae97-96dd3de9090c`）。未解決は 0
- 持ち主の判断: 合意した計画を共有した後、実装の前に Go を待つ

## 目的

実装に入る前に、Claude と Codex が計画を議論して合意を取る。合意できない点は持ち主が決める。合意した計画はファイルに残す。

## 対象外

- 実装の後の差分レビュー（`codex-review`）
- 規範が別扱いにしている可逆な作業（文書・設定の整理、リネーム）
- 計画の記録を DB へ入れること（`trace` は持ち主が頼んだときだけ使う）

## 方針

- Skill は `.claude/skills/grill-with-codex/SKILL.md`。Claude Code 専用で、`.agents/skills` に置かない（Codex から見えない）
- 計画は `.claude/plans/<YYYY-MM-DD>-<slug>.md`。git で追跡する。1 件 1 ファイルで、合意した時点の実装計画
- 1 往復目は、持ち主の要求・決定事項・叩き台・参照先だけを渡す（Claude の予想反論は渡さない）
- 2 往復目以降は、指摘 ID ごとの返答（受理 / 根拠付き反論 / 保留）と計画の変更箇所を渡して議論する
- 終わる条件は「直した計画について重大な未解決点が無いと Codex が確かめた」。4 往復は時間の上限で、合意の代わりにしない
- 決まらない点だけを、選択肢と双方の根拠を添えて持ち主へ聞く。時間切れと CLI の失敗は対立と分けて報告する
- 共有した後、持ち主の Go を待つ。同じ範囲に Go が出ている依頼なら待たない
- CLAUDE.md に「実装の前に grill-with-codex で計画を詰める」の 1 行を足す（Skill は必ず起動するとは限らない）

## 採った案と棄却した案

- 採った: 計画を `.claude/plans/`。棄却: Skill の中の `plans/`（定義と生成物が混ざる）
- 採った: 計画を git で追跡。棄却: gitignore の作業文書（後から実装範囲と Go の対象を確かめられない）
- 採った: 合意の判定を文章で。棄却: `--output-schema` の JSON（形は検証できても判断の妥当性は検証できない。`resume` に無い）
- 採った: 再開のたびに `-c sandbox_mode="read-only"` を付ける。棄却: 付けずに再開する（実測で workspace-write になり、書き込めた）
- 採った: 共有した後に Go を待つ（持ち主の判断）。棄却: 共有してそのまま実装（Codex が不同意）

## 手順

1. `.claude/skills/grill-with-codex/SKILL.md` を書く（Triggers と Does not trigger、1〜7 の手順）
2. この計画ファイルを `.claude/plans/` に置く
3. CLAUDE.md に「実装の前」の節を足す
4. `scripts/check-ai-config.mjs` で Claude 専用の Skill にも開発用 Skill と同じ検査を当てる
5. `docs-audit` と Codex のレビューを受けて直す

## 検証

- `resume` の権限: `-c sandbox_mode="read-only"` 無しでは `sandbox: workspace-write` で `touch` が通った。付けると `sandbox: read-only` で `Operation not permitted`（2026-09-23 の実測）
- `bun run verify:ai`（Claude 専用の Skill の frontmatter と、消した語の検査に入る）
- 新しい session で Skill の一覧に出ること

## リスク

- 1 往復に 10〜15 分かかる。争点が無ければ 1 往復で終える
- Codex の「合意」は自己申告。Claude が根拠と計画の改訂を照合する
