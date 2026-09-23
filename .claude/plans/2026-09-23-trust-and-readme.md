# 信頼できる plugin だと示す（PR 7a・7r・7b）

- 日付: 2026-09-23
- Codex との議論: 3 往復（session `01a0cde4-e765-77a2-a2d9-35e0578f618b`）。重大な未解決点は 0
- 持ち主の判断: Dependabot・OpenSSF Scorecard・SLSA を入れる。README のバッジは License・CI・OpenSSF Scorecard・SLSA・Dependabot の 5 つ。README は利用者向けに英語で全面刷新し、その後 README.ja.md。About は英語の説明と topics

## 目的

導入する人が「安心して入れられる plugin だ」と判断できる材料を、実在する仕組みと検証できる表示で揃える。
バッジは実際に動いて確かめた後にだけ出す。

## 対象外

- git の履歴の書き換え
- SLSA Build L3（reusable workflow の `actions/attest` が要る。L2 で足りる）
- bun の依存の Dependabot（`server/bun.lock` は lockfileVersion 2 で、Dependabot は 1 までしか読めない）
- CONTRIBUTING.md（第三者の PR を受けないので、作ると期待を誤らせる）

## 方針

3 つの PR に分け、7a → 7r → 7b の順に入れる。

### 7a: 報告窓口・Dependabot・Scorecard（配布物は変わらない）

- `SECURITY.md`: 連絡は GitHub の private vulnerability reporting。持ち主が有効にし、報告ボタンが見えることを確かめてから README で案内する
- `.github/dependabot.yml`: github-actions だけ。weekly、cooldown 7 日、groups で 1 本にまとめる（cooldown と groups はセキュリティ更新には効かない）
- `.github/workflows/scorecard.yml`: 独立した workflow。top-level と job に `env`・`defaults` を置かない。`publish_results: true`、権限は job 単位、actions は SHA で pin。点数のために設定を変えない

### 7r: release を CI の staged publishing へ移す（最初の staged release）

- `.github/workflows/release.yml`（`v*` の tag の push）
  - `prepare` job（読む権限だけ）: tag 名が npm・Claude Code と Codex の plugin manifest・marketplace の `source.version` の全部と一致する。tag の commit が、base が main の open な同じリポジトリの PR の head である。その PR の現在の仮 merge commit で `check` の全 matrix・`windows`・`pr-body` が成功していて、仮 merge commit の tree が tag の commit の tree と一致する。`bun run setup` → `bun run verify` → `npm pack` → 共有の tarball 検査 → SHA-512 を job summary へ出し、tgz を artifact に渡す
  - `stage` job（environment `npm-release`、`id-token: write`）: 起動直後に prepare の条件を検査し直す。受け取った tgz の SHA-512 を照合する。Node は 24.18.1 に固定し、`npm --version` が 11.15.0 以上かを確かめる。`npm stage publish <tgz> --tag next` を実行し、stage の ID と run を summary に残す
  - PR では `prepare` 側の検査を走らせる。stage は tag のときだけ
- 持ち主の手順: PR（Codex レビュー、CI 緑）→ PR の head に `vX` を打って push → environment を承認 → `npm stage download` で SHA-512 を CI の値と照合し、provenance を確かめてから 2FA で承認 → merge 直前に PR の head と base を確かめる → `gh pr merge --merge --match-head-commit <sha>` → merge commit と tag の tree が一致することを確かめる → `npm pack gleanery@X` の SHA-512 を照合 → `npm dist-tag add … latest` → plugin を更新 → `release:status`
- 失敗したとき: `vX` を打ち直さない。stage は 2FA で reject し、新しい version と tag で出し直す。承認後に merge できなければ latest に上げず、`next` を直前の正常版へ戻して、新しい version で出し直す
- 消す: `release-prepare.mjs`（手元で作った tgz を publish する前提が誤りになる）。tarball の検査は共有の script にし、手元でも呼べるようにする
- 直す: `release-plan.mjs` の案内、`release-status.mjs`（stage 中・`next`・`latest` を区別して表示）、`.claude/rules/verification.md` の release の節、`plugin-release` Skill
- 配布物: npm と plugin manifest の `description` を英語にする（バージョンを上げ、7r を最初の staged release にして provenance を実測する）
- 持ち主が画面で設定するもの（PR 本文に一覧にする）: npm の trusted publisher（stage 専用、workflow と environment を指定）・2FA 必須・token 禁止、GitHub の environment `npm-release`（reviewer は持ち主、自己承認の禁止は off）・tag `v*` の作成・更新・削除を持ち主だけに限る ruleset・main の必須チェック（`pr-body` を含む）・private vulnerability reporting

### 7b: README・README.ja.md・About（配布物が変わる）

- README.md を英語で書き直す。節は次の順: 題 → バッジ 5 つ → `English | [日本語](README.ja.md)` → tagline → Features → Requirements（Node.js 24.15+）→ Install（`npm i -g gleanery`、Claude Code と Codex の plugin、`gleanery init`、`gleanery project add`、`gleanery doctor`）→ Quick start（最初の recall まで）→ What gets recorded & privacy → Updating / Uninstalling → Troubleshooting → Commands → Security → Contributing → License
  - What gets recorded & privacy: 記録先は手元の SQLite で、gleanery のアカウントは要らない。`harvest` は `git fetch` と `gh api` を使う。伏せられない秘密がある
  - Commands: 主な操作の例と `gleanery --help` への案内だけにする
  - Contributing: 1 節だけ。issue は受ける。外からの PR はレビューせずに閉じる（理由を 1 文）
- バッジ
  - License: shields の GitHub license
  - CI: `check.yml` の workflow badge
  - OpenSSF Scorecard: api.scorecard.dev。7a の初回の結果が公開されてから出す
  - SLSA: 「SLSA Build L2」と書き、npm の provenance へリンクする。7r で実測してから出す
  - Dependabot: 「Dependabot: GitHub Actions」と書き、`dependabot.yml` へリンクする。本文に bun の依存は対象外と書く
- README.ja.md は、英語版の刷新の後の commit で作る
- npm のページにも README を出す: bundle で README.md を `plugin/` へ写し、`files`・`scripts/lib/tarball.mjs` の必須一覧・`release-scope.mjs` に加える。README の中のリンクは絶対 URL にする
- `check-pairs.mjs` で README の CLI 一覧を書き換える処理を消す（正本は `--help` だけ）
- 今の README の開発者向けの内容は消す。足りない command があれば CLAUDE.md・AGENTS.md へ移す
- About: 英語の説明と topics の案を持ち主に出し、承認を得てから `gh repo edit`

## 採った案と棄却した案

- 採った: 3 PR に分ける。棄却: 仕組みと release を 1 PR に入れる（release の順序が変わり、影響が大きい）
- 採った: staged publishing で、持ち主が SHA-512 と provenance を確かめてから承認する。棄却: CI から直接 publish する（検査済みの候補を人が見る段が消える）
- 採った: PR の head に tag を打ち、merge の前に stage する。棄却: merge の後に tag を打つ（merge から承認まで、marketplace が未公開の version を指す）
- 採った: 7r に英語の description を入れて provenance を実測し、その後に 7b で SLSA バッジを出す。棄却: 7b の release で初めて provenance を付ける（README は merge した時点で表示されるので、確かめる前に L2 を名乗る）
- 採った: 失敗したら version を上げて出し直す。棄却: 同じ tag を打ち直す（provenance の参照先が追えなくなる）
- 採った: release job の Node を 24.18.1 に固定する（npm 11.16.0 を同梱）。棄却: `npm i -g npm@X`（install が 1 つ増える）
- 採った: CONTRIBUTING.md は作らず、README に Contributing の 1 節だけ置く。棄却: 開発手順を CONTRIBUTING.md へ移す
- 採った: SLSA は L2 と名乗る。棄却: L3（署名を隔離する workflow が要り、手間に見合わない）

## 手順

1. 7a: ブランチを切り、この計画を最初の commit に入れる。→ 実装 → verify → Codex レビュー → PR → merge → Scorecard の初回の実行と公開を確かめる
2. 7r: 実装 → verify → review-shipping・Codex レビュー → PR → 持ち主が画面で設定 → 上の手順で最初の staged release → provenance を確かめる
3. 7b: README.md → README.ja.md → review-shipping・Codex レビュー → PR → 7r と同じ経路で release → About の案を出して承認を取る

## 検証

- 7a: dependabot.yml を GitHub が受け付ける（Insights の Dependabot の画面にエラーが無い）。Scorecard の workflow が成功し、api.scorecard.dev に結果が出る
- 7r: PR で `prepare` の検査が走る。version の不一致・main に向かない PR・CI が赤い head・tree の不一致をそれぞれ拒むことを、script の test で確かめる（先に red を見る）。初回の stage で、CI の SHA-512 と `stage download` の SHA-512 が一致し、公開後の版に provenance が付いている
- 7b: `npm pack` した tarball に README.md が入り、npm のページに出る。README のリンクが切れていない。書いてある command を実際に打って確かめる
- 各 PR: `bun run verify`、CI

## リスク

- 初回の stage で OIDC や provenance が期待どおり動かないかもしれない（未実測）。そのときは承認せず、手順を見直す
- 承認から merge までの間に PR の head や main が動くと、公開した版が main に入らない。latest に上げず、`next` を戻して新しい version で出し直す
