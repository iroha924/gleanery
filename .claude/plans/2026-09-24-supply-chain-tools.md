# 供給網の検査と証明を足す（zizmor・OSV-Scanner・Renovate・SBOM・harden-runner・Best Practices）

- 日付: 2026-09-24
- Codex との議論: 3 往復（session `01a0d187-e992-7432-9f7e-0411a6828277`）。重大な未解決点は 0
- 持ち主の判断: 表の 7 つを全部入れる。README のバッジは 5 つのまま。GitHub・npm・外部サービスの設定は持ち主が行うか承認する
- 前提（事実）: secret scanning と push protection は既に有効（public のリポジトリなので自動）。Dependabot alerts は有効にしたが、依存のグラフは `server/package.json` の直接の依存 19 件だけで `server/bun.lock` を読んでいない

## 目的

CI と配布の経路への攻撃に強くし、推移的な依存の脆弱性と更新に手を届かせ、配布物の中身を外から確かめられるようにする。

## 対象外

- gleanery のコードそのものの欠陥（レビューと test が見る）
- README のバッジを増やすこと（5 つと決めてある。ルートの README は npm に入るので、編集すると配布物も変わる）
- dependency submission（Contents の write を持つ job が増える。まず OSV で運用し、Dependabot alerts へ寄せる必要が出たら別に検討する）
- OSV の PR 用の reusable workflow（比較のファイルを PR 側の symlink で上書きできる報告がある。google/osv-scanner-action#136）

## 方針（4 つの PR）

### PR 1: zizmor・OSV-Scanner・Renovate

- zizmor: zizmor-action と zizmor 本体の版を固定し、PR と main への push で走らせて SARIF を上げる（指摘で job は落とさない）。初回の指摘は同じ PR で直す（`actions/checkout` の `persist-credentials: false` など）
- OSV-Scanner: 公式の reusable workflow（全体の走査）を SHA で pin し、main への push・週 1 の schedule・その workflow ファイル自身を paths に持つ pull_request で走らせる。fork の PR では走らせない。`fail-on-vuln: false` を明示し、走査そのものの失敗だけを job の失敗にする。必須の checks にはしない。初回の結果を見て既知の扱いを決める
- Renovate: Mend の GitHub App を持ち主が gleanery 1 つに限って入れる。`renovate.json` で `enabledManagers: ["bun"]`、`minimumReleaseAge` 7 日（Dependabot の cooldown と揃える）、lockFileMaintenance を週 1（依存の更新とは別の PR になる）。github-actions は Dependabot のまま
- Bun の年齢制限: `server/bunfig.toml` に Bun の minimumReleaseAge（7 日）を置く。Renovate の設定だけでは、lockFileMaintenance が解決し直す推移的な依存まで 7 日待つ保証にならないため。Bun 1.4.0 で効くことと frozen install が通ることを実走で確かめる（効かなければ計画を直す）

### PR 2: SBOM と attestation

- SBOM は、`server/bun.lock` と配布用の依存の範囲（`THIRD_PARTY_NOTICES.md` と同じ範囲）から CycloneDX を作る（cdxgen か syft。どちらも bun.lock に対応）。`THIRD_PARTY_NOTICES.md` の package の一覧と照合する。tarball だけからは作らない（依存は `dist/*.js` にバンドルされ、tarball に `node_modules` も `bun.lock` も無い）
- SBOM は release.yml の prepare で作る（PR でも走るので、生成と照合は PR 2 の中で実走させる）。artifact と job summary に残す
- attestation は stage の job で、tarball の SHA-512 の照合の後・`npm stage publish` の前に置く（`actions/attest` の SBOM モード。subject は照合した同じ tarball。権限は `id-token` と `attestations` の write だけ）
- 完了の条件: PR 2 を merge した後の次の release（配布物の変更がある回）で、npm から取った tarball に `gh attestation verify <tgz> --repo iroha924/gleanery --predicate-type https://cyclonedx.org/bom --signer-workflow iroha924/gleanery/.github/workflows/release.yml` が通る。それまで PR 3 に進まない

### PR 3: harden-runner の audit

- 持ち主がテレメトリの送信を判断してから入れる（プロセス名・引数・通信先・書いたファイルの path が StepSecurity に送られる。ソースと secret の値は送られない。`disable-telemetry` は block のときだけ使える）
- 全 job の先頭に audit で入れる（Scorecard の job も公式に許されている）
- 完了の条件: stage を含む実際の release で、prepare と stage の通信先を観測する

### PR 4: stage の block

- PR 3 で観測した通信先（npm の registry、GitHub、Sigstore など）だけを許し、stage の job を block にする
- 次の release で、stage が通ることと、許可先の外への通信が止まることを確かめる

### コードの PR の外

- OpenSSF Best Practices badge: 質問票の下書き（項目ごとの根拠の URL）を Claude が用意し、持ち主が答える
- secret scanning の non-provider patterns と validity checks: 持ち主が有効にするかを決める（validity checks は generic patterns には効かない）

## 採った案と棄却した案

- 採った: 4 つの PR に分ける。棄却: 1 つの PR（静的検査・依存の更新・release の証明・外部への送信・通信の遮断の成否が混ざる）
- 採った: OSV は全体の走査だけで、PR の新規の比較はしない。棄却: 公式の PR 用 workflow を必須にする（比較のファイルを上書きできる報告がある）
- 採った: Renovate の年齢制限に加えて Bun の minimumReleaseAge を置く。棄却: Renovate の設定だけにする（推移的な依存の再解決に効かない）
- 採った: SBOM は bun.lock と配布用の依存の範囲から作る。棄却: tarball から作る（バンドルした依存が見えない）
- 採った: harden-runner は audit で観測してから block。棄却: 最初から block（通信先を知らずに止めると release が落ちる）
- 採った: Renovate は Mend の App を 1 つのリポジトリに限って使う。棄却: 自前の action（PAT か App token の管理が要り、権限の広さは変わらない）
- 採った: dependency submission は見送る。棄却: 今入れる（Contents の write を持つ job が増える）

## 手順

1. PR 1: 作業ブランチを切り、この計画を最初の commit に入れる → 手元で zizmor を流して指摘を直す → workflow と renovate.json と bunfig.toml → Bun の年齢制限を実走で確かめる → verify・review-shipping・Codex → PR（OSV の workflow が PR の中で走ることを確かめる）→ merge → 持ち主が Mend の App を入れる → 最初の Renovate の PR を確かめる
2. PR 2: SBOM の生成と照合 → PR の中で prepare が走る → merge → 次の release で attestation を verify
3. PR 3: 持ち主の判断 → audit → release で観測
4. PR 4: 観測した許可先で block → release で確かめる

## 検証

- zizmor: SARIF が code scanning に上がる。初回の指摘を直した後の結果
- OSV: PR 1 の中で全体の走査が走り、SARIF が上がる。既知の脆弱性で job が落ちない
- Renovate: 最初の PR が bun の依存だけを対象にし、7 日より新しい版を提案しない。lockFileMaintenance の PR で `bun install --frozen-lockfile` が通る
- Bun の年齢制限: 7 日より新しい版を、直接・推移的な依存のどちらにも入れない
- SBOM: `THIRD_PARTY_NOTICES.md` の package と一致する。次の release で `gh attestation verify` が上の条件で通る
- harden-runner: release の実走で通信先が観測できる。block の後、stage が通り、許可先の外が止まる

## リスク

- Mend の App は Contents・PR・Workflows の書き込み権限を持つ（`enabledManagers` では狭まらない）
- harden-runner は job のメタデータを第三者（StepSecurity）へ送る
- 検査と更新の PR が増え、一人開発では捌く手間が増える
- OSV の初回の走査で既知の脆弱性が多く出ると、扱いの判断が要る
