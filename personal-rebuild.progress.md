# mitos を個人の道具に戻し、判断の地図を中心にした画面へ作り替える

> mitos に残るのが本人のリポジトリの記録だけになり、追跡ファイルから特定の組織・第三者に紐づく記述が検索して 0 件になること。あわせてダッシュボードが、チャットを中心に据えた 6 画面（質問する / 作業の現在地 / 記録を探す / 記録 / 会議を聞き取る / 設定）として動き、bun run check とテスト 42 件と本番ビルドが通ること。**地図として出す案は d-drop-map で棄却したので、完了条件から外してある**（変更の経緯は d-goal-after-map）

- 状態: 進行中
- 対象: mitos (main)
- 最終更新: 2026-09-08T03:45:00+09:00
- 人間向けの表示: `personal-rebuild.progress.html`

## いまここ

地図をやめてチャットを中心に戻し、そこから画面全体を作り直した。チャットは往復の形（自分の発言は右の吹き出し、答えは地の文）になり、会話の題は LLM が付ける。音声入力は whisper-1、会議の聞き取りは Realtime へ 2 系統を別々に流す形で入っている。検索は既定で bot の発言を外し、現在地は phases の未完だけを出す。書体は Geist と Murecho、配色は #2C2C2B を基準にした白黒。直前に直したのは「このプロジェクトは何か」に答えられなかった件で、原因は DB にプロジェクトの定義が無いこと（scope.summary が空）。プロンプトで README を読ませる回避を入れたが、根本の summary は空のまま。レビュアー 1 体に .md だけを渡して 23 件の指摘を受け、再開できない箇所と証拠の無い断定を裁定した（目的が地図を要求したままだった点、push 範囲、地図に依存する過去の検証、件数の母数、bot 発言 139→138 の誤り）。ファビコンとアプリアイコンを「折り返す糸」で入れた（d-icon-folded-thread）。**37 コミットを origin/main へ push 済み（a9decb4）。**残る未着手は、プロジェクトの定義を DB に持たせること（scope.summary が空）。残る 1 工程は、**人に一行説明を書かせるのではなく、AI がリポジトリを読んで scope.role / summary を埋める**形に方針が変わった（d-infer-project-identity）。**期限のある未決が別に 1 件ある** — 退職日までに ~/.claude/projects/ 配下の会話ログ原本（17MB・10 ファイル）を消すかどうか。リモートは 1a9dae7 で、手元と一致している

### 工程

- 完了: DB の削除
- 完了: リポジトリの記述
- 完了: 方向を選ぶ
- 完了: 地図の実装（のち d-drop-map で削除）
- 完了: 画面の展開
- 完了: 名前の見直し
- 完了: 音声入力と会議の聞き取り
- 完了: shadcn へ寄せる
- 完了: 書体と配色
- 完了: チャット画面の作り直し
- 未着手: プロジェクトの定義を DB に持たせる（AI が読んで埋める）
- 完了: この回のコミットを push（a9decb4）

## 次にやること

- 次のセッションでやること: **リポジトリを読んで scope.role / scope.summary を AI が埋める経路を作る**（d-infer-project-identity）。人に書かせる `mitos describe` は棄却済みなので、そちらへ戻らないこと。いまの回避（システムプロンプトで README を読ませる）は残したままでよいが、恒久策と取り違えない。決めることは q-identity-scope に置いてある (ai)
- 2026-09-07 時点で「あと 1 週間」と言われた退職日までに、勤務先のリポジトリ名を含む ~/.claude/projects/ 配下の会話ログ原本（17MB・10 ファイル）を消すかどうかを決める。消すと、そのリポジトリでの作業の一次記録が失われる（DB からは既に消えており、取り込み直す経路も退職後は無い）。残すと、パス名自体が勤務先を示すものが手元に残る。この回でも未決 (human)
- 次の職場で取り込みを始めたら、relation 表に書き手を作るかを判断する。地図は削除したので線種の枠は消えたが、relation 表と parent_id は残っている (human)

## 未解決の問い

- `q-advice-feedback` 編集フックの助言が役に立ったかを、どう受け取るか。出したことは jsonl に残るが、採用されたかを記録する先が無い。これが埋まらない限り mitos advice は「出したか」までしか測れず、賢くなっているかを主張できない — 答えるのは 人 / この作業の外
- `q-force-layout-scale` 力学配置が節 330 件で読める状態は確認したが、次の職場で数千件になったときに読めるかは分からない。件数が増えたら畳み方（既定で発言と出来事を隠す以上のもの）が要る可能性がある — 答えるのは AI / 実装中に解ける
- `q-title-backfill` LLM が題を付ける前に作られた会話の題を、付け直すかどうか。ChatGPT は過去の会話名を変えないのでそれに倣って何もしていないが、新旧が混ざって並んでいる — 答えるのは 人 / いま答えが要る
- `q-busy-until-titled` 答えを読み終えてから 1.7〜2.5 秒、入力欄が「止める」のままになるのを直すか。直すには done イベントで busy を落とす配線が要り、SSE の扱いが 1 段複雑になる。放置しても壊れない — 答えるのは 人 / この作業の外
- `q-realtime-gap` 会議の聞き取りで、再接続の間に流れた音声が落ちる件をどうするか。d-realtime-not-chunking の引き受けた不利として書いたきり、直す判断も直さない判断もしていない。**落としたことが画面に出ないので、利用者からは欠落に見えない。**直すなら、落ちた区間を画面に印として出すのが最小 — 答えるのは 人 / 実装中に解ける
- `q-scrub-pattern` 目指すところの中心条件「追跡ファイルから特定の組織・第三者に紐づく記述が検索して 0 件」を、**いま再確認する手段が無い。**v-scrub の grep パターンは、記録自体に語を書き戻さないためプレースホルダにしてある（前回のレビューで最重要として受理した対処）。語の一覧はどこにも保管しておらず、再確認するには本人が組み直す必要がある。gitignore した手元のファイルに置くか、確認をやめるかを決める — 答えるのは 人 / いま答えが要る
- `q-identity-scope` 要約を作る単位と頻度をどうするか。取り込みのたびに作り直すと遅くなり、一度だけだとリポジトリの性格が変わったときに古びる。また README の無いリポジトリで何を読むか（CLAUDE.md → AGENTS.md → package.json → ディレクトリ構成、のどこまで落ちるか）も決まっていない — 答えるのは AI / 実装中に解ける
- `q-sidebar-focus-bg` サイドバーの項目に足した `focus-visible:bg-sidebar-accent`（dashboard/src/components/ui/sidebar.tsx の 6 箇所）を残すか。**本人が選んだ「枠の色だけ変える」の範囲外**で、枠を持たない項目でフォーカスの位置が完全に消えるのを避けるために足した。外すとキーボードでサイドバーを辿れなくなる — 答えるのは 人 / いま答えが要る
- `q-scrub-pattern-2` （q-scope-summary を畳んだ差し替え。あちらは「mitos describe をどう埋めるか」を人に聞く形で立てていたが、d-infer-project-identity でその設計自体を棄却したので問いとして成立しなくなった。**人に聞くのではなく q-identity-scope として AI が決める形へ移した。**）残っている人への問いは、目指すところの中心条件「追跡ファイルから特定の組織・第三者に紐づく記述が検索して 0 件」を再確認する手段が無いこと（q-scrub-pattern と同じ） — 答えるのは 人 / この作業の外

## 背景

退職が 1 週間後に決まり、mitos が持っていた記録の 99% が勤務先のもの（8 作業場所・node 35,074 件）だった。持ち続ける理由が無くなった一方で、道具そのものは次の職場でも使う。加えて、勤務先のデータを前提に作ったダッシュボード（ルート 8 本: / /chat /search /records と詳細 /projects /people /terms）は shadcn の既定のまま外観に固有性が無く、依頼者から「全体的に微妙」と言われていた。

### 制約

- ダッシュボードの設定用ロール mitos_cfg には record と node への書き込みを与えない。推論する層に書き込みを持たせない設計の根拠がここにあり、削除のために緩めると境界が消える
- MCP と編集フックは読み取り専用の資格情報で動く。PR コメントや issue 本文という外部の文章を読む層なので、書き込みを足すと記録に仕込まれた文言が設定を書き換える経路ができる
- git 履歴には手を付けない。リポジトリが private であることを根拠に、書き換えないと決めた

### やらないこと

- 勤務先の Linear issue 4,393 件の取り込み。退職により回収できないため着手しない
- 評価セットの作り直し。実際の質問が chat_message に 9 件しか無く、母数が足りない
- 「役に立ったか」を受け取る仕組みの実装。記録する表と書き込み権限の設計から要るため今回は作らない
- ローカルの会話ログ原本（~/.claude/projects 配下 17MB）の削除。今回は判断材料を出すところまでにした — 消せば一次記録が戻らず、残せばパス名が勤務先を示す。どちらを取るかは本人の判断で、次にやることへ移した

## 意思決定

### d-abandon-linear-import

**Linear の取り込み拡大を打ち切り、精度を上げる作業自体をここで止める**

- 状態: accepted / 09-07 01:55
- 文脈: 網羅性を上げるために勤務先の Linear issue を取り込む案を検討していた。実測で、コーパスが番号で名指ししている issue が 944 件あり、取り込み済みは 22 件だけだった。そこで依頼者へ 「Linear の取り込み対象をどこまで広げますか。」と 3 案（34 件 / 922 件 / 4,393 件）で問うた。回答は返らず、代わりに退職が 1 週間後であること、Linear は今だけ必要で次は GitHub Issues か JIRA になることが示された。
- 検討した案:
  - 採用: 打ち切る
  - 棄却: 自分の発言が言及する 34 件を入れて効果を測ってから広げる — 1 週間後に退職するため、測って広げる時間も、広げた結果を使う時間も無い
  - 棄却: コーパスが言及している 922 件を一気に入れる — 約 62 分と node 12% 増の投資に対し、回収期間が 1 週間しかない
  - 棄却: チーム全体 4,393 件 — そもそも過剰。自分の作業が一度も参照していない issue が 3,449 件含まれ、検索の分母を増やすだけになりやすい。所要は 922 件で実測 62 分の外挿として約 5 時間で、これは推定値
- 結果:
  - 5 時間（922 件の実測 62 分からの外挿）の取り込みと、その後の削除の手間を両方回避した
  - (不利) 網羅性は 0.5%（22/4,393）のまま。ドメイン知識に強くするという当初の最重要要件は未達で終わる
  - この判断の直後に方針が「全削除」へ変わったため、取り込まなかったことが結果的に正しかった
- 守られていることの確かめ方: Linear の作業場所が DB に残っていないことを mitos scopes で確かめる
- 検証: v-no-linear-scope [pass]
- 根拠: $ node scratchpad/refs.ts (exit 0)

### d-keep-git-history

**git 履歴は書き換えない**

- 状態: accepted / 09-07 02:45
- 文脈: 追跡ファイルからは記述を除いたが、過去 56 コミットのうち最大 10 コミットが会社の記述を含んでいる。リポジトリは本人の GitHub アカウントで private。コミットメッセージ側の汚染は 0 件だった。
- 検討した案:
  - 採用: 履歴に手を付けない
  - 棄却: git filter-repo で全履歴を置換し、MEMORY.md と評価 JSON をパスごと削除して force push — GitHub は force push で参照されなくなったオブジェクトをしばらく SHA 指定で辿れる状態に残すと一般に言われており、書き換えても消えたと言い切れない。この点は一次ソースで検証していないため推測にとどまる
  - 棄却: 履歴を捨てて 1 コミットにする — 同じ理由で確実性が上がらないうえ、mitos 自身の開発履歴 56 コミットを失う
- 結果:
  - 手間をかけずに済み、開発履歴が残る
  - (不利) private であることに依存する。公開へ切り替えると履歴も一緒に出る
  - (不利) 確実に消したくなったときは、force push ではなく現在のツリーから新しいリポジトリを作り直す必要がある
  - (不利) 棄却理由の中心が未検証の推測（force push 後もオブジェクトが辿れる）に乗っている。一次ソースで否定されたら、この決定は書き換える側へ倒れる
- 守られていることの確かめ方: gh repo view iroha924/mitos --json isPrivate が true を返し続けていることを、公開へ切り替える前に確かめる
- 検証: v-private-repo [pass]
- 根拠: $ gh repo view iroha924/mitos --json visibility,isPrivate (exit 0)

### d-edges-from-parent-and-ref

**辺は parent_id（決定と棄却された案）と ref から導き、relation 表は参照しない。線種の枠だけ残し、データが入ったら出る形にする**

- 状態: accepted / 09-07 10:25
- 文脈: 地図の設計は relation 表（supersedes / verifies / answers など）で線種を描き分ける前提だったが、その表は 0 行で書き込む経路が無い（e-relation-empty）。実在するのは node.parent_id 47 件と ref_link 370 件。
- 検討した案:
  - 採用: parent_id と ref から導く
  - 棄却: relation 表を読む — 0 行なので線が 1 本も出ない。モックと違って辺の無い地図が出る
  - 棄却: relation に書き手を作ってから地図を実装する — 何を supersedes と判定するかの設計が要り、今回の範囲（画面の作り替え）を超える。退職まで 1 週間で回収できない
- 結果:
  - いまのデータでそのまま動き、棄却された案が赤い破線として実際に出る
  - (不利) 「覆した決定」「答えた問い」は表現できない。画面には枠だけがある
  - relation に書き手ができたとき、地図の実装を変えずに線が増える
- 守られていることの確かめ方: /api/graph の戻り値で edges の kind が parent_id 由来（rejected と considered）と ref 由来（belongs）だけであること、および rejected と considered の合計が node.parent_id を持つ節の件数と一致することを確かめる
- 検証: v-edge-kinds [pass] / v-relation-no-writer [pass]
- 根拠: $ curl -s 'http://localhost:8787/api/graph?scopes=1' (exit 0)

### d-ref-as-hub

**PR とファイル（ref）を節として地図に出し、そこへぶら下げる。2 件以上を束ねる ref だけを結び目にする**

- 状態: accepted / 09-07 15:05
- 文脈: 310 節のうち 209 が辺を持たず、引用が意味のない場所で光っていた（e-isolated-nodes）。ref_link のリンクは 5 つの ref に 239 本が集中しており、節どうしを総当たりで結ぶと 1 つの ref で数千本の辺になる。
- 検討した案:
  - 採用: ref を結び目の節として出す
  - 棄却: ref を共有する節どうしを総当たりで結ぶ — 1 つの ref に n 件ぶら下がると n(n-1)/2 本の辺になる。実測では 5 つの ref に 239 リンクが集中しており、最大のものだけで数千本に達する（100 件なら 4,950 本という計算値）。実際そのために 2〜8 件の ref しか使えておらず、239 本のリンクを捨てていた
  - 棄却: 辺を持たない節は光らせず「地図に置けない根拠」として一覧に出す — 引用の多くが event と utterance なので、地図と答えを結ぶ機能がほとんど発火しなくなる
- 結果:
  - 辺を持たない節が 209 件から 84 件へ減り、引用が PR やファイルの近くに置かれる
  - (不利) 地図に判断でないものが増える。小さい菱形にして色を持たせないことで区別している
  - (不利) ref も親も持たない 84 件は依然として構造を持たない。記録ごとの錨へ弱く引き寄せることで「どの作業の話か」までは固めた
- 守られていることの確かめ方: /api/graph の戻り値で、辺を持たない節の数が全節の 3 割未満であることを確かめる。増えてきたら結び目の作り方を見直す
- 検証: v-graph-edges [pass]
- 根拠: $ curl -s 'http://localhost:8787/api/graph?scopes=1&kinds=all' (exit 0)

### d-keep-now-screen

**「作業の現在地」は残し、記録の一覧画面（/records の index）だけを削除する**

- 状態: accepted / 09-07 15:58
- 文脈: 「本当に価値のあるものだけ残す」方針で ルート 8 本（当日 /advice を足して 9 本）を見直した。地図が記録の中身を出すので、記録を並べる画面は重複しているように見えた。
- 検討した案:
  - 採用: 一覧だけを削り、現在地は残す
  - 棄却: 現在地と一覧の両方を削る — API を叩いたら現在地は地図に無いものを持っていた。工程・次の一手の担当区分・制約 8 件・どこで止まったか（e-now-screen-kept）
  - 棄却: どちらも残す — 一覧が出す項目は現在地の出す項目の部分集合で、遷移先も同じ。増える情報がない
- 結果:
  - 重複が消え、記録へ入る経路は現在地とサイドバーの 2 つに整理された
  - (不利) 削れたのはルート 9 本のうち 1 本だけだった。設定 3 画面（/projects /people /terms）はいま空でも次の職場で最初に触るので残した
- 守られていることの確かめ方: routeTree.gen.ts に /records/ の index ルートが無く、/records/$id だけがあることを確かめる
- 検証: v-route-tree [pass]
- 根拠: $ grep -n records dashboard/src/routeTree.gen.ts (exit 0)

### d-concrete-labels

**画面の名前を「何が得られるか」に変える。作業の現在地 / 質問する / 編集時の助言 / 記録を探す / 記録 / 社内語の辞書 / 名簿**

- 状態: accepted / 09-07 16:05
- 文脈: 画面の名前を製品の思想から取っていた（いま / 聞く / 探す / 先に言う）。依頼者から「抽象的すぎてパッと何のことか分からない」と指摘された。
- 検討した案:
  - 採用: 何が得られるかを名前にする
  - 棄却: 思想を映した名前のままにする — 中身を知っている人にしか読めない。とくに「先に言う」はいつ出るのかが名前に無かった
  - 棄却: 名前は変えず、説明文を添える — サイドバーの幅では説明が入らない。読む前に選ぶ場所なので、名前そのものが読めないと意味がない
- 結果:
  - 初見で何の画面か分かる
  - (不利) 製品の思想（聞かれる前に言う、辿れば戻れる）が名前から消える。各画面の中の説明文へ移した
- 守られていることの確かめ方: サイドバーの項目名とヘッダの見出しが一致していることを画面で確かめる
- 検証: v-labels [pass]
- 根拠: commit 8e3942f

### d-delete-not-scrub

**この 3 つは語の置換ではなく、ファイルごと（評価セットは中身ごと）捨てる**

- 状態: accepted / 09-07 02:30
- 文脈: 記述を取り除く対象のうち 3 つは、置換では扱えなかった。引き継ぎ用の MEMORY.md は本文のほぼ全体が勤務先の実測値と固有名で、評価セット 5 本は問いと期待値そのものが勤務先の PR 番号・日付・件数でできている。編集フックのログは 3 行のうち 1 行が勤務先のリポジトリを指していた。依頼者からは MEMORY.md とフックのログについて明示的に削除の指示があった。
- 検討した案:
  - 採用: MEMORY.md を削除し、評価セット 5 本を空の cases にし、フックのログを削除する
  - 棄却: 他の 29 本と同じく語を置換する — 評価セットは問い自体が勤務先の作業の記述で、語を置き換えると意味を成さない問いが残る。MEMORY.md も同様で、置換後に残るのは骨格だけになる
  - 棄却: フックのログを行単位で除く — 3 行のうち助言を出せたのは 1 行だけで、それが勤務先のものだった。残る 2 行は「黙った」記録なので、残しても指標にならない
  - 棄却: 退避してから消す — 退避先が手元にある限り、消したことにならない。退職に伴う削除という趣旨に反する
- 結果:
  - 語の置換では残ってしまう文脈（どの PR で何件だったか）まで消える
  - 評価セットの機構（must / mustNot、re: の正規表現、多ターンの不変条件）は残るので、次の職場で問いだけ書けば動く
  - (不利) 回答精度 74/74 を測り直す手段が同時に失われた。d-abandon-linear-import が「網羅性 0.5% のまま」と書いた未達を、以後どう測るかは持っていない
  - (不利) フックの助言の履歴が復元できない。効き目の指標は次にフックが走るところから貯め直しになる
- 守られていることの確かめ方: server/evals/*.json が cases 空で、かつ evals の実行体（answers.ts / multi.ts / hybrid.ts）が残っていることを確かめる
- 検証: v-evals-shell [pass]
- 根拠: commit df48d72

### d-drop-map

**地図（/api/graph と地図の画面）を削除し、チャットを中心に戻す**

- 状態: accepted / 09-07 19:32
- 文脈: 地図（判断のつながりのグラフ表示）を「聞く」の中心に据えて実装し、幅の配分・ノードの間隔・初期倍率まで 5 往復ぶん調整した。そのうえで本人が「グラフDBって必要か？これ見ててもあまり参考にならなかった」と言い、外して先へ進む判断になった。実装した本人（AI）が価値を主張できる材料を出せなかった。
- 検討した案:
  - 採用: 地図を削除し、API・画面・配色変数まで一緒に落とす
  - 棄却: 見た目の調整を続ける（間隔・倍率・obsidian 風のレイアウト） — 5 往復調整しても「参考にならない」が変わらなかった。調整の面に終端が無く、続けても収束しない
  - 棄却: 隠して残す（feature flag / ルートだけ外す） — 使わないコードが残ると、次に触る人が生きている機能だと思って直しにくる。互換 shim を残さず消す方針に反する
- 結果:
  - チャットが唯一の中心になり、画面の説明が要らなくなった
  - (不利) d-ref-as-hub（PR とファイルを結び目として辺を作る）の成果が画面から消えた。relation 表と parent_id は残るので、地図を作り直す判断は将来もできる
  - (不利) 地図のために入れた配色変数が孤児になり、別コミット（e396e66）で拾い直す手間が出た
  - (不利) dashboard/src/components/graph.tsx が消えたため、この記録の以前のエントリ（e-label-collapse）が証拠として指すファイルが解決できなくなった。主張そのものは当時の観測として有効だが、いまのツリーには当たらない
- 守られていることの確かめ方: dashboard/src と server/src に graph という語で当たる実装が 0 件であること
- 検証: v-graph-gone [pass]
- 根拠: commit 904cd60 / commit e396e66

### d-whisper-1

**文字起こしを OpenAI の whisper-1 にし、手元の whisper.cpp を捨てる**

- 状態: accepted / 09-07 21:03
- 文脈: チャットの音声入力を最初は手元の whisper.cpp（kotoba-whisper-v2.0）で実装した。本人の実声 2 本（各 100 文字前後）で精度を測ったところ、手元のモデルは長さが伸びると崩れた。会議 1 時間を週 4〜5 回という利用量でも API の費用は問題にならないと本人が判断した。
- 検討した案:
  - 採用: whisper-1（API）
  - 棄却: kotoba-whisper-v2.0（手元） — 50.6 秒の音声を 20.7 秒で打ち切った
  - 棄却: large-v3-turbo（手元） — 同じ音声で「退避させる」を「対比させる」と誤変換した。whisper-1 は同じ音声で誤りが 0 だった
  - 棄却: gpt-4o-transcribe / gpt-4o-mini-transcribe — 本人が実声で比べて whisper-1 を選んだ（「whisper-1一択だな」）
- 結果:
  - 音声が長くなっても末尾が落ちない。ffmpeg も分割処理も要らなくなり、実装が 1 リクエストに縮んだ
  - (不利) 録った音が外部 API へ出る。手元で完結する構成は捨てた
  - (不利) 会議の音声が API の 25MB 上限に当たらないよう、MediaRecorder を 24kbps に落とす必要が出た
- 守られていることの確かめ方: server/src/http.ts の /api/transcribe が whisper-1 を呼び、ffmpeg にも分割処理にも依存していないこと
- 検証: v-transcribe-whisper1 [pass]
- 根拠: commit fcdb540

### d-two-streams-not-diarization

**話者分離をせず、自分のマイクと画面共有のタブ音声を別々の 2 系統として録る**

- 状態: accepted / 09-07 21:24
- 文脈: 会議で相手の発言に返信案を出すには、誰が話したかが要る。話者分離のやり方を調べたが、日本語の会議音声の評価データが手に入らず、精度を測れない。一方で会議は Google Meet 6 割・Zoom 2 割・Teams 2 割で、対面はほぼ無い。
- 検討した案:
  - 採用: 2 系統を別々に録り、系統そのものを話者の識別にする
  - 棄却: 1 本にまとめて話者分離モデル（pyannote 等）にかける — 日本語の会議音声の評価データが手に入らず精度を測れない。測れないものを入れると、外れたときに気付けない
  - 棄却: 対面も想定して 1 本録りにする — 本人の会議は 10 割が画面越し。対面はほぼ無い
- 結果:
  - 話者が推論ではなく事実になる。分離の精度という不確かさが設計から消えた
  - (不利) 対面の会議では使えない
  - (不利) getDisplayMedia の systemAudio に依存する。ブラウザとOSの版に制約が付く
- 守られていることの確かめ方: dashboard/src/routes/mtg.tsx が listen() を 2 回、別々の MediaStream で呼んでいること
- 検証: v-two-streams [pass]
- 根拠: commit 9c69ffb / file dashboard/src/routes/mtg.tsx

### d-realtime-not-chunking

**20 秒の固定区切りをやめ、OpenAI の Realtime transcription（wss、intent=transcription）へ流す**

- 状態: accepted / 09-07 21:36
- 文脈: 会議の聞き取りを、20 秒ごとに音声を切って /api/transcribe へ投げる形で実装した。本人に「20 秒の区切りっていうのはベストプラクティス？独自実装？」と聞かれ、独自実装であることを認めた。プラットフォームが既に持っているものを手で書き直していた。
- 検討した案:
  - 採用: Realtime transcription へ PCM を流し続ける
  - 棄却: 20 秒ごとに切って whisper-1 へ投げる — 独自実装。区切りが語の途中に落ちると前後の文が壊れ、境界をまたぐ文脈も失う
  - 棄却: 無音位置で切る（c444d85 で一度実装した） — 切る位置を賢くしても、切ること自体が独自実装である点は変わらない
  - 棄却: openai の SDK をブラウザへ入れて接続する — ダッシュボードのバンドルが 261kB 増える。SDK の実装から接続の契約（サブプロトコルと ephemeral token の渡し方）を読み取り、素の WebSocket で同じことをした
- 結果:
  - 文字起こしが区切りに縛られず流れ続ける。返信案を出す判断が話し終わりに揃う
  - (不利) ephemeral token が 600 秒で切れるので、会議中に取り直す仕組みが要る（fa017ed で入れた）
  - (不利) 再接続の間に流れた音声は落ちる。落としたことを画面に出していない
- 守られていることの確かめ方: dashboard/src/lib/listen.ts が WebSocket を張り、openai パッケージを import していないこと
- 検証: v-realtime-raw-ws [pass] / v-mtg-end-to-end [not-run]
- 根拠: commit 84b6039 / commit fa017ed / file dashboard/src/lib/listen.ts

### d-exclude-bot-utterances

**検索の既定から utterance を外す（kinds で明示されたときだけ含める）**

- 状態: accepted / 09-07 22:43
- 文脈: 検索の結果に bot の定型文（CI の通知、自動レビューの決まり文句）が並び、判断の記録を押しのけていた。DB を数えたところ、node 379 件のうち 159 件が utterance で、そのうち 138 件が bot 由来だった。
- 検討した案:
  - 採用: search.ts の where 句に n.kind <> 'utterance' を既定で足す
  - 棄却: bot の投稿者名で除外する — 名前の一覧を持つことになり、新しい bot が入るたびに漏れる
  - 棄却: 取り込みの側で bot を入れない — 発言は経緯として価値がある。引けなくするのではなく、既定で前に出さないだけにしたい
- 結果:
  - 検索と MCP の search_knowledge の両方が同時に直った（同じ関数を通っている）
  - (不利) 発言を探したいときは kinds に utterance を明示する必要がある
  - (不利) DB の bot 発言 139 件はそのまま残っている。import-github を回せば同じ比率で増える
- 守られていることの確かめ方: server/src/search.ts の clauses が kinds 未指定のとき n.kind <> 'utterance' を含むこと
- 検証: v-search-excludes-utterance [pass] / v-bot-utterances [pass]
- 根拠: commit 5b0eba5 / file server/src/search.ts

### d-now-by-phases

**/now の画面は残し、status を信じずに phases の未完で絞る。phases を持てない record（GitHub 由来）は最初から除く**

- 状態: accepted / 09-07 23:11
- 文脈: 本人が「作業の現在地は不要では」と言い、削除も含めて検討した。実際の画面を見ると、終わっている作業（hir4ta-developer）と、工程 6 件が 6 件とも完了している personal-rebuild が「進行中」として並んでいた。status は書き手が手で書く値で、phases と同期していない。
- 検討した案:
  - 採用: phases に done でない工程が残っているものだけを出す
  - 棄却: 画面ごと削除する — 残す条件を出せたので削除の理由が消えた。ただし「現在地を見て何をするのか」という本人の問いには、まだ画面の側が答えていない
  - 棄却: status = 'in-progress' で絞る（従来） — 手で書く値なので実態と合わない。全工程 done でも in-progress のまま残る
- 結果:
  - 終わった作業が現在地から消えた
  - (不利) phases を書かない取り込み経路（GitHub 由来の record）は、この画面から永久に見えない
  - (不利) status 列が何のためにあるのかが未解決のまま残った
- 守られていることの確かめ方: /api/now の SQL が jsonb_array_elements(r.phases) の state <> 'done' で絞っていること
- 検証: v-now-sql [pass]
- 根拠: commit ec72545 / file server/src/http.ts

### d-session-end-hint

**SessionEnd フックで、編集があって /mitos:trace を起動していないセッションにだけ systemMessage を出す**

- 状態: accepted / 09-08 00:01
- 文脈: 本人から「セッションを閉じる前に保存を促せないか。あくまで促す、強制ではない」と要望が出た。公式ドキュメントで SessionEnd は exit code 2 を無視し、プロンプトも出せない（Cannot block / Cannot prompt）ことを確かめた。
- 検討した案:
  - 採用: systemMessage で促すだけ。止めない
  - 棄却: exit 2 で終了を止める — SessionEnd は exit 2 を無視する。実装しても効かない
  - 棄却: 常に促す — 読むだけのセッションで促しても残すものが無い。Edit/Write/NotebookEdit が 0 件なら黙る
- 結果:
  - 保存し忘れに気付ける。残すかどうかは人が決めたままになる
  - (不利) transcript を毎回全文読むので、長いセッションでは終了時に一拍かかる
  - (不利) スキルを起動したかで見ているので、起動して途中でやめたセッションは促されない
- 守られていることの確かめ方: plugin/hooks/session-end が TRACED を含む transcript と、編集 0 件の transcript のどちらでも無言で exit 0 すること
- 検証: v-session-end-silent [pass] / v-hook-doc [pass]
- 根拠: commit 86c2a22 / file plugin/hooks/session-end

### d-chat-as-conversation

**往復の形にする。質問は右寄せの吹き出し、答えは地の文。shadcn の bubble / message / input-group / empty を使い、自前のマークアップを捨てる**

- 状態: accepted / 09-08 00:55
- 文脈: チャットは「1 往復を 1 本の短い記事として読ませる」形で、質問を h2 の見出しにし、日付と範囲を上に乗せ、答えを本文としていた。本人から「チャットっぽいUIじゃない。マークダウンページみたいで、私の一言目がタイトルみたいになってる」と指摘が出た。
- 検討した案:
  - 採用: shadcn の bubble / message / input-group / empty で組む
  - 棄却: 記事型を維持する — 聞いた本人の一言が記事の題に化けて、続けて聞くほど誰が書いたのか読めなくなる
  - 棄却: 吹き出しを自前で書く（最初はこうした） — 本人から shadcn に bubble があると指摘された。プラットフォームが持っているものを手で書き直していた
- 結果:
  - 誰の発言かが位置で分かる。ホバーで写すボタン、伸びる入力欄、空の状態が shadcn の作法で揃った
  - (不利) 読む幅を 83rem から 64rem へ狭めた。以前『倍くらいに広げて』と言われた箇所を、往復の形に合わせて戻している
  - (不利) InputGroup の has-disabled に踏んだ（e-input-group-has-disabled）。送信ボタンだけ aria-disabled にする回避が残っている
- 守られていることの確かめ方: dashboard/src/routes/index.tsx に h2 の質問見出しが無く、Bubble と Message と InputGroup を使っていること
- 検証: v-chat-no-heading [pass]
- 根拠: commit 8c20c26 / commit 815b16c / file dashboard/src/routes/index.tsx

### d-title-from-answer

**質問と答えの両方を渡して題を作らせる。答えの完了を待ってから会話を作る**

- 状態: accepted / 09-08 00:48
- 文脈: 会話の題は質問の先頭 120 文字を切っていた。話し言葉の質問（「今どこまで進んでて、次何する?」）がそのまま並び、一覧で何の話か読み取れない。ChatGPT のように LLM に付けさせたい、という要望。
- 検討した案:
  - 採用: 質問と答えを渡す
  - 棄却: 質問だけを渡し、答えの生成と並行して作る（追加の待ち時間 0） — 同じ 6 会話で比べたところ、質問を言い換えるだけになった。『記録の保管先って、どこにしたっけ』→『記録保管先の決定』（質問だけ）に対し『ルート直下のprogressファイル』（答えも見る）
  - 棄却: 仮の題で先に保存し、題は後から更新して titled イベントで知らせる — busy の解除が SSE の切断に紐づいているので、ストリームを開いたままにすると結局待たせる。イベントとDB更新を足すぶん複雑になる
- 結果:
  - 一覧で何の話だったかが読める題になった
  - (不利) 答えを流し終えてから履歴に載るまで 1.7〜2.5 秒かかる。その間、送信ボタンは「止める」のままになる
  - (不利) 既存の会話の題は付け直していない。新旧が混ざって並ぶ
- 守られていることの確かめ方: server/src/http.ts の saveTurn が、新規会話のとき titleFor(question, answer) を待ってから insert していること
- 検証: v-title-strategy [pass] / v-title-in-savetun [pass]
- 根拠: commit aec5f73 / file server/src/http.ts

### d-readme-for-identity

**プロジェクトそのものを問われたら、答える前に README を read_code で読ませる。グラウンディングの硬さは緩めない**

- 状態: accepted / 09-08 01:05
- 文脈: 「このプロジェクトについて2行で教えて」に対し、直近のセッション記録だけを読んで「退職に伴い個人用へ戻し、画面を作り替えた作業」と答えた。DB を見ると mitos の record は 1 件だけで、それは作業のセッション記録。scope.role と scope.summary は両方 null。README.md の 3 行目に道具の定義が書かれていたが、システムプロンプトはコードを見る場面を「実装の場所と中身」に限っていた。
- 検討した案:
  - 採用: システムプロンプトに「プロジェクトの定義はリポジトリに聞く」を足す
  - 棄却: 「渡されたものの中だけで答える」を緩め、一般知識で補わせる — 過去の決定を捏造しない性質がこの DB の存在意義そのもの。緩めると核が壊れる
  - 棄却: 先に mitos describe で scope.summary を埋める — hir4ta-developer が何のリポジトリかを本人にしか決められない。プロンプト側の修正はデータ入力なしで全リポジトリに効くので、そちらを先に入れた
- 結果:
  - 同じ質問が「PR・issue・コード・会話から開発知識をたどれる形で蓄積するナレッジ DB」と答えるようになった
  - (不利) 毎回 README を読む往復が入る。この質問での応答は 6.7 秒だった
  - (不利) scope.summary が空である根本は残っている。summary が埋まれば往復は要らなくなる
- 守られていることの確かめ方: server/src/chat.ts の SYSTEM に「このプロジェクトは何か」を README へ回す節があること
- 検証: v-readme-grounding [pass] / v-system-readme [pass]
- 根拠: commit 15c3423 / file server/src/chat.ts

### d-stay-on-vite-react

**Vite + React + Hono のままにし、Next.js へ移さない**

- 状態: accepted / 09-07 19:45
- 文脈: 本人から「ReactじゃなくてNext + Honoは？」と提案があった。「Next + Hono を考えたのは、どのあたりが理由ですか？」と聞き返したところ、「特に理由はない、聞いてみただけ」という回答だった。**動機が無い移行だったので、移行しない側の根拠を出す方に倒した。**server/src には入口が 4 つある（http.ts のダッシュボード API、mcp.ts の MCP サーバー、cli.ts、hook-check-path.ts の編集フック）。ダッシュボードはそのうち 1 つでしかない
- 検討した案:
  - 採用: いまの構成（Vite + React、Hono の API）を維持する
  - 棄却: Next.js + Hono へ移す — 入口が 4 つあるうちの 1 つのために全体を Next の作法へ寄せることになる。MCP サーバーと CLI と編集フックは Next の恩恵を受けず、ビルドの経路だけが増える。提案側にも動機が無かった
- 結果:
  - 4 つの入口が同じ素の TypeScript のまま並び、ビルドの経路が 1 本で済む
  - (不利) SSR やファイル規約による routing の恩恵は受けない。ダッシュボードは今のところ手元でしか動かさないので影響が無いが、外へ出す判断をしたら再検討になる
- 守られていることの確かめ方: server/src に http.ts / mcp.ts / cli.ts / hook-check-path.ts の 4 つの入口があり、dashboard が Vite で建っていること
- 検証: v-four-entrypoints [pass]
- 根拠: file server/src/http.ts / file server/src/mcp.ts / file dashboard/vite.config.ts

### d-goal-after-map

**目指すところから地図を外し、「チャットを中心に、記録を読む・探す・会議で引く画面が動くこと」に書き換える**

- 状態: accepted / 09-08 02:00
- 文脈: 目指すところに「ダッシュボードが、判断のつながりを地図として出す画面へ作り替わり」と書いてあるが、d-drop-map で地図は削除した。**完了条件が、途中で捨てたものを要求したまま残っていた。**レビュアーの指摘（#1）で気付いた。加えて「実機の全画面が動くこと」に対応する工程も検証も無かった。
- 検討した案:
  - 採用: 目的を書き換え、その変更自体を決定として残す
  - 棄却: 元のまま置く — 再開者が「あと何をすれば終わりか」を記録から決められない。地図を作り直さない限り永久に未達になる
  - 棄却: 記録を閉じて新しい記録を作る — 目的は変わっていない（mitos を個人の道具に戻す）。変わったのは手段だけで、分けると経緯が切れる
- 結果:
  - 完了条件が、いま存在する画面だけで判定できるようになった
  - (不利) 目的を後から書き換えた記録になる。地図に投じた作業（d-ref-as-hub、d-edges-from-parent-and-ref）は目的から外れた位置に残る
- 守られていることの確かめ方: 目指すところに「地図」の語が無く、画面の一覧が dashboard/src/routes の実体と一致すること
- 検証: v-routes-count [pass]
- 根拠: file dashboard/src/routes/index.tsx

### d-geist-murecho

**欧文を Geist、和文を Murecho、等幅を Geist Mono にする**

- 状態: accepted / 09-08 00:48
- 文脈: 本人から「フォントに合わせて UI を作っている感じがある。可愛くてポップなので、もっとモダンで整然とした感じにしたい」と言われた。使っていたのは M PLUS Rounded 1c（丸ゴシック）と、本来はディスプレイ書体である Space Grotesk を等幅として流用したもの。**package.json に Geist と Murecho が既に入っていて、どこからも使われていなかった。**
- 検討した案:
  - 採用: Geist + Murecho（どちらも既に依存にある）+ Geist Mono を追加
  - 棄却: M PLUS Rounded 1c を残す — 丸ゴシックが「ポップ」の正体だった。43MB・1778 ファイルあり、削除でリポジトリも軽くなる
  - 棄却: Space Grotesk を等幅のまま使う — ディスプレイ書体で、字形に癖がある。数字と札を本文から分ける役には向かない
  - 棄却: 和文を OS の書体（Hiragino Sans）に任せる — macOS でしか同じ見た目にならない。Murecho は unicode-range で分割配信され 1 ファイル約 13KB なので、配信量の理由が立たない
- 結果:
  - 欧文と和文が別々の書体で組まれ、数字と識別子が本文から分かれて読める
  - (不利) 書体に合わせて font-extrabold 4 箇所を semibold へ、カードの浮き上がる影と translate を平らな色変化へ直す作業が付いてきた
  - (不利) 「モダンで整然」が達成できたかを測る基準は無い。本人の目視だけで判定している
- 守られていることの確かめ方: dashboard/src/styles.css の --font-sans が Geist Variable と Murecho Variable を並べ、m-plus-rounded-1c が依存から消えていること
- 検証: v-fonts [pass]
- 根拠: commit aec5f73 / file dashboard/src/styles.css

### d-icon-folded-thread

**「折り返す糸」を採る。縦に伸びた線が下で折り返して途中で止まり、辿り着いた先を点で置く**

- 状態: accepted / 09-08 02:40
- 文脈: ファビコンが未設定だった。dashboard/public に紫のマーク（favicon.svg）と SNS アイコン束（icons.svg）が置いてあったが、**index.html からどこも参照しておらず**、テンプレート由来の残骸だった。第一条件は 16px のブラウザタブで潰れずに読めること。配色は既存のトークン（#2C2C2B と ほぼ白）だけで、色は足さない。4 方向を同じ枠・同じ実寸（32 / 16 / 16 暗 / アプリ）で並べて本人に選ばせた。
- 検討した案:
  - 採用: 折り返す糸 — μίτος（ギリシャ語の「糸」）そのもの。辿れば元の判断まで戻れることを、折り返す線で表す
  - 棄却: 採った節と棄てた節 — 塗った点が採用した判断、輪郭だけの点が棄却した案。線でつなぎ、同じ重みで持つことを示す — 16px では輪の内側が 2px しか残らない。タブの縮小で塗りつぶれ、塗りと輪郭の差が消える。第一条件（16px で読める）を満たせない
  - 棄却: 頭文字の m — Geist の m をパスで描く。16px で最も確実に読め、白黒基調に素直に馴染む — 何の道具かが名前でしか分からない。m で始まる他の道具と並ぶと見分けが付かない
  - 棄却: 分岐と行き止まり — 縦線が通った道、右へ伸びた枝が塞がれている。棄却した案と行き止まりを同じ重みで持つ設計をそのまま形にする — 本人が折り返す糸を選んだ。抽象度が高く説明を聞くまで意味が伝わらない点、塞ぐ棒が「一時停止」に見える点が不利だった
- 結果:
  - 名前（μίτος = 糸）と印が一致する。由来を説明すれば一度で伝わる
  - 線 3 要素・すべて 2 単位の太さで 16 の格子に乗っているので、16px でも 180px でも滲まない
  - SVG の中で prefers-color-scheme を見ているので、暗いタブでは字面が反転する
  - (不利) 「糸」と読めるのは名前を知っている人だけ。初見では U か釣り針に見える
  - (不利) iOS 用の PNG は暗い地に固定なので、明暗の追随はブラウザのタブだけ。2 枚を別々に持つことになった
- 守られていることの確かめ方: dashboard/index.html が /favicon.svg と /apple-touch-icon.png を参照し、両方が 200 で返ること。favicon.svg の viewBox が 0 0 16 16 で stroke-width が 2 のままであること（ここを変えると 16px で滲む）
- 検証: v-icon-wired [pass] / v-icon-shape [pass] / v-icon-seen-by-others [not-run]
- 根拠: file dashboard/public/favicon.svg / file dashboard/public/apple-touch-icon.png / file dashboard/index.html

### d-infer-project-identity

**作業場所の説明は人に書かせない。**リポジトリを読んで AI が自分で要約し、scope.role / scope.summary を埋める経路を作る****

- 状態: accepted / 09-08 03:20
- 文脈: チャットが「このプロジェクトについて 2 行で教えて」に、直近のセッション記録だけを読んで「退職に伴い個人用へ戻した作業」と答えた（e-no-project-identity）。原因は scope.role と scope.summary が両方 null で、プロンプトの『いま見ている範囲』が `- iroha924/mitos` としか出ていなかったこと。その場では `mitos describe` で人が役割と一行説明を書く案を「次にやること」へ置いたが、**本人に設計として否定された** — 「明示しないといけないのは間違い。AI に見に行かせて理解させるのが重要。わざわざ明示しないと理解できないのは JARVIS ではない」。
- 検討した案:
  - 採用: 取り込みのときにリポジトリを読ませ、role と summary を自動で埋める
  - 棄却: mitos describe で人が一行説明を書く（コマンドは前から存在する） — mitos が目指しているのは検索ではなく「聞かれる前に言う」こと。人が前提を書き足さないと働かない道具は、その目的と矛盾する。**本人が設計として棄却した**
  - 棄却: 設定画面に入力欄を作って書かせる — 同じ理由。入口を画面に変えても、人が明示する構造は変わらない
  - 棄却: いまの回避（システムプロンプトで README を読ませる）を恒久策にする — 質問のたびに README を読み直す往復が入る（実測 6.7 秒）。答えられるようにはなったが、DB は依然としてプロジェクトの定義を持っていない。MCP や編集フックなど、チャットを通らない経路には効かない
- 結果:
  - 人が前提を書き足さなくても、道具が自分でプロジェクトを理解する。JARVIS の側へ 1 歩寄る
  - チャット以外の経路（MCP の search_knowledge、編集フック）からも同じ理解が使えるようになる
  - (不利) AI が書いた要約が誤っていても、人が気付く場所が無い。要約の出所（どのファイルの何行目から書いたか）を残す必要がある
  - (不利) README の無いリポジトリでは何を読むかが決まらない。読む順（README → CLAUDE.md → AGENTS.md → package.json）と、どれも無いときの振る舞いを決める必要がある
  - (不利) 取り込みのたびに要約を作り直すのか、一度だけかを決めていない。毎回作ると取り込みが遅くなり、一度だけだとリポジトリの性格が変わったときに古びる
- 守られていることの確かめ方: 新しい作業場所を取り込んだ直後に scope.role と scope.summary が埋まっていて、「このプロジェクトは何か」に README を読み直さずに答えられること
- 検証: v-identity-auto [not-run]
- 根拠: file server/src/cli.ts / file server/src/chat.ts / file README.md

### d-focus-no-ring

**リングをやめ、枠の色の変化だけでフォーカスを示す。枠を持たないサイドバーの項目は、ホバーと同じ背景で示す**

- 状態: accepted / 09-08 03:25
- 文脈: 本人から「input や select、tabs で何かしようとすると border が太くなる。これは何？無効にできる？」と聞かれた。実測すると、枠が太くなっているのではなく **shadcn が focus-visible で枠の外側に 3px のリングを足していた**（box-shadow に `oklab(0.7 0 0 / 0.5) 0 0 0 3px`、同時に枠の色が oklch(0.915) から oklch(0.7) へ）。見かけの太さは 0.83px + 3px ≈ 3.8px。テキスト入力でマウスのクリックでも出るのは仕様で、ブラウザは文字入力を受け付ける要素にはマウス操作でも :focus-visible を立てる。「フォーカスの表示をどうしますか。」を 3 案で聞き、本人が選んだ。
- 検討した案:
  - 採用: リングをやめ、枠の色だけ変える（太さは一切変わらない）
  - 棄却: リングを 1px に細くする — 太さが変わること自体をやめたかった。1px でも枠が動いて見える
  - 棄却: 完全に消す — キーボードで移動したときに現在位置が分からなくなる。マウスだけで使う前提でも、Tab での移動が事実上使えなくなる
- 結果:
  - 入力欄・select・タブ・ボタンで、フォーカスしても寸法が一切変わらなくなった
  - (不利) タブとボタンは base に border-transparent があるので、透明だった 1px の枠が灰色になる。位置は分かるが層が薄い
  - (不利) サイドバーの項目には枠が無く、リングを外すと印が完全に消えたので focus-visible:bg-sidebar-accent を 7 箇所足した。**本人が選んだ範囲の外**なので、不要なら外す
  - (不利) shadcn の CLI で部品を入れ直すと、既定の 3px リングが戻ってくる
- 守られていることの確かめ方: src/components/ui/ に focus-visible と ring の幅を同時に持つクラスが残っていないこと（ring-0 の打ち消しと aria-invalid のエラー表示は別物なので残す）
- 検証: v-focus-no-shadow [pass] / v-focus-values [pass]
- 根拠: commit 810615c / file dashboard/src/components/ui/input-group.tsx

## 経過

- `e-purge-timeout` 09-07 02:05 [駄目だった道] 35,074 行とその cascade を 1 つの DELETE で消そうとして、Supabase の statement_timeout（postgres ロールで 2 分）に当たり ROLLBACK した。データは 1 行も消えていない。node を 1,000 行、ref を 5,000 行ずつの塊に割り、文ごとに自動コミットさせる形で通した（所要 244 秒） — $ node scratchpad/purge.ts (exit 1)
- `e-purge-scope` 09-07 02:10 [作業] 会社側の作業場所 7 件を削除した。node 34,764 件・record 82 件・孤児 ref 10,059 件・person 6 名・chat 8 件・用語 1 件・束 1 件。残ったのは iroha924/hir4ta-developer の 1 件で node 310 件、名簿は本人のみ。削除は CLI 側の全権ロール（postgres / SUPABASE_DB_URL）で行い、画面用の mitos_cfg には権限を足していない — $ node scratchpad/purge2.ts (exit 0)
- `e-zsh-word-split` 09-07 02:18 [駄目だった道] ファイル一覧を変数に入れて perl へ未クォートで渡したが、zsh は未クォートの変数を単語分割しないため、改行を含む 1 つのファイル名として渡り全件が開けなかった。xargs 経由に変えて通した — $ perl -CSD -i -pe ... $FILES (exit 0)
- `e-perl-encoding` 09-07 02:20 [駄目だった道] perl -CSD で一括置換したところ、ASCII の置換だけが効いて日本語が 1 つも置き換わらなかった。-CSD はファイルを文字列へ復号するが、スクリプト中の日本語リテラルは use utf8 が無いためバイト列のままで、突き合わせが外れる。さらに日本語を置換先に使った 1 箇所が二重エンコードされて文字化けした。バイトモード（-CSD なし）で流し直して解決した — $ git grep -c '<置換したはずの人名>' (exit 0)
- `e-hnsw-reclaim` 09-07 02:25 [判明したこと] 行を消しても HNSW 索引と表の領域は返らない。VACUUM FULL を掛けて node 表が 565MB から 4,992kB、DB 全体が 1,068MB から 640MB になった — $ node scratchpad/vac.ts (exit 0)
- `e-repo-scrub` 09-07 02:32 [作業] 追跡ファイル 29 本から組織名・リポジトリ名・チーム名・issue 番号・実名・ハンドルを置き換え、MEMORY.md を削除、評価セット 5 本を空にした。会社由来の記述はコメント・例示・プレースホルダ・テストのフィクスチャだけに存在し、ロジックには入っていなかったので挙動は変わっていない — commit df48d72
- `e-relation-empty` 09-07 10:20 [判明したこと] relation 表が 0 行だった。決定・棄却・検証・覆した決定を線種で描き分ける設計はこの表を前提にしていたが、書き込む経路がどこにも無い。辺は node.parent_id（47 本）と ref_link から導くことにした — $ node scratchpad/graphdata.ts (exit 0)
- `e-chat-source-nodeid` 09-07 10:45 [作業] ChatSource に nodeId を足した。答えの引用を地図で指すには節の id が要るが、元の型は label と text しか持っていなかった。道具（find_prs や grep_code）が返した根拠は節ではないので null になる — commit f7520c3
- `e-shell-vs-viewport` 09-07 11:55 [駄目だった道] シェルの max-w-4xl が地図の画面にも掛かり、地図の幅が 270px に潰れていた。読む画面と地図の画面で幅の要求が違うので、パスで全幅を切り替える形にした — file dashboard/src/routes/__root.tsx
- `e-label-collapse` 09-07 12:10 [駄目だった道] 節の札に max-width だけを与えたところ、和文が 1 文字ずつ縦に折り返して縦書きのように見えた。絶対配置の要素は包含ブロック（点の幅 26px）を基準に幅を縮めるため。固定幅に変えて解決した — file dashboard/src/components/graph.tsx
- `e-click-coordinate` 09-07 13:10 [判明したこと] ブラウザ自動操作で「選択できない」「地図が 700px 飛ぶ」と 2 回報告したが、どちらも実装の欠陥ではなくクリック座標のずれだった（画面の実寸 2560×1232 に対しスクリーンショットが 1568×755）。要素を ref で指定すれば正しく動く。ただしこのとき入れた 2 つの直し（掴みが描画時の視点を引き算していた構造、節の上では掴まない）は残してある。前者は視点が入れ替わると実際に飛ぶ形だった — file dashboard/src/components/graph.tsx
- `e-bigint-as-string` 09-07 13:40 [判明したこと] node-postgres（pg 8 系）は bigint / int8 を文字列で返す。桁が JS の安全な整数を超えうるための既定の挙動で、型変換を登録しない限り変わらない。この 1 つの理由で 3 回壊れた。答えの引用が地図で 1 つも光らない、検索結果が地図の節と一致しない、結び目 20 個が全部辺ゼロで浮く。地図と検索が画面へ返す id をすべて数へ寄せて解決した（/api/graph の 4 箇所は SQL で ::int、検索は chat.ts で Number()）。**この 4 + 1 箇所を数えただけで、リポジトリ全体を走査したわけではない**。負の値（-r.id）も同じで、括ってから落とす必要がある — file server/src/http.ts / file server/src/chat.ts
- `e-isolated-nodes` 09-07 14:50 [判明したこと] 310 節のうち 209 が辺を持っていなかった。ref_link のリンク 239 本が 5 つの ref に集中しており、総当たりで辺にすると 1 つの ref だけで数千本になるため 2〜8 件の ref しか辺にしていなかったことが原因。力学配置は辺の無い節を意味のない外周へ飛ばすので、答えの引用がそこで光ると無関係な空白を指しているように見えた — $ node scratchpad/iso.ts (exit 0)
- `e-advice-log-leftover` 09-07 15:50 [判明したこと] ~/.claude/mitos-advice.jsonl に会社のリポジトリを指す行が残っていた。同種のファイルである mitos-sync.log は削除済みだったが、こちらを見落としていた。編集フックの画面を作ったことで表示されて気付いた。削除した。このログを書くのは PreToolUse の編集フック（server/src/hook-check-path.ts、配布物は plugin/dist/hook-check-path.js）で、Edit / Write / NotebookEdit のたびに 1 行追記する。画面が空なら、まだ編集していないだけ — $ rm -f ~/.claude/mitos-advice.jsonl (exit 0)
- `e-now-screen-kept` 09-07 15:55 [判明したこと] 「作業の現在地」の画面を地図と重複しているとみなして削除しようとしたが、API を叩いたら地図に無いものを持っていた。工程 6 件（5 完了）、あなたがやること／AI に任せることの区別、触ってはいけない制約 8 件、どこで止まったか。削らずに残した — $ curl -s http://localhost:8787/api/now?scopes=1 (exit 0)
- `e-push` 09-07 16:00 [状態の変化] コミット 8 本を origin/main へ push した（df48d72 と、地図の実装 7 本）。リモートは 8e3942f — $ git ls-remote origin refs/heads/main (exit 0)
- `e-review-triage` 09-07 16:30 [作業] まっさらなレビュアー 1 体に .md だけを渡して確認させ、指摘を全件裁定した。受理して直したのは、記録自体が消したはずの語をリポジトリへ戻す点（最重要）、決定の確かめ方と検証の不一致 2 件、破壊的スクリプトを検証の再現手段にしていた点、実測でない数（4,950 本・5 時間）の断定、棄却理由の無い削除 3 件、画面数の食い違い、310 と 330 の差、node-postgres の版、「すべてに ::int」の言い過ぎ、進行中の理由。見送ったのは 4 件。(a) 決定の根拠が確かめ方と別の対象を測っているという指摘は、根拠は文脈側の主張（944 件）を支えており、確かめ方には別途 v-no-linear-scope を結び付けてあるため。(b) 残存件数の根拠が削除の実行体だという指摘は、そのスクリプトが削除後の検算まで同一実行で出しているため。(c) 設定 3 画面を残す判断を独立した決定にすべきという指摘は、理由が d-keep-now-screen の不利な結果として既に書かれており、決定を分けても振る舞いが変わらないため。(d) 退職日を絶対日付にすべきという指摘は、伝えられたのが「あと 1 週間」という相対表現だけで、確定日を書くと推測を事実として残すことになるため。**なお、指摘のうち 1 件は誤っていた** — v-checks にテスト件数と時点が無いという指摘だが、IR には入っており、Markdown の描画が pass の output を出さないだけだった。数字を what 側へ移して読めるようにした — file personal-rebuild.progress.md
- `e-mobile-dropped` 09-07 19:35 [判明したこと] モバイル対応を要望として受けて測り始めたが、本人が「モバイルは不要だった。PC でしか使わない」と撤回した。**要望が出た時点で作らず、まず測ってから聞いたので手戻りは調査だけで済んだ** — file dashboard/src/routes/__root.tsx
- `e-bun-dev-zellij` 09-07 19:40 [判明したこと] bun run dev をバックグラウンドで起動すると zellij の raw-mode エラーで落ちる。API（node src/http.ts）と Vite を別々に起動する必要がある。**node は監視しないので、サーバー側を直したら API を再起動しないと反映されない** — $ bun run dev (exit 1)
- `e-zsh-word-split-again` 09-07 20:50 [駄目だった道] zsh は引用符なしの変数を単語分割しない。whisper.cpp の比較で $VA に「--vad -vm <path>」を入れて渡したところ、全体が 1 個の引数として渡って whisper-cli が即死し、スクリプトは前回の x.json をそのまま読んで比較表を出した。**出た数字は前の実行のもので、比較になっていなかった。**分岐を明示的に書き分けて直した。このセッションで同じ罠を踏んだのは 2 回目 — $ whisper-cli
- `e-nt-drops-tail` 09-07 20:55 [駄目だった道] whisper.cpp の -nt（no-timestamps）は末尾のセグメントを落とす。最初これを「長い音声だと末尾が落ちる」というモデル側の性質だと報告したが、原因はオプションの方だった。**実装の選び方が変わる誤診断だったので訂正した** — $ whisper-cli -nt
- `e-tail-collapse-at-length` 09-07 21:00 [駄目だった道] 手元のモデルは 104 文字の実声では末尾が落ちなかったので「実声では落ちない」と報告したが、280 文字では 1/3 程度しか残らなかった。**先に出した判断が誤りだったので訂正した。**長さを変えずに 1 本だけで測ると、この崩れ方は見えない — $ whisper-cli
- `e-transcribe-model-choice` 09-07 21:03 [作業] 「文字起こしのモデルをどちらにしますか？」を選択肢付きで出したが、本人は選択肢からではなく文章で「whisper-1一択だな」と答えた。**選択の記録は AskUserQuestion 側に残らないので、判断の中身は d-whisper-1 に置いてある** — commit fcdb540
- `e-openai-sdk-bundle` 09-07 21:36 [判明したこと] Realtime に繋ぐために openai の SDK をダッシュボードへ入れると、バンドルが 261kB 増えた。SDK の実装から接続の契約（wss の intent=transcription、サブプロトコルに ephemeral token を載せる形、PCM 24kHz を base64 で input_audio_buffer.append）を読み取り、素の WebSocket で同じことをした — $ bun run build
- `e-agent-claim-unverified` 09-07 23:05 [判明したこと] 画面の監査に立てたサブエージェントが「束が空なので /now が唯一の入口だ」と主張した。受け入れかけたが lib/project.tsx を読むと localStorage から復元しており、**成り立つのは初回起動のときだけ**だった。サブエージェントの結論も、根拠を確かめてから採る — file dashboard/src/lib/project.tsx
- `e-navmenu-stays-open` 09-08 00:26 [駄目だった道] shadcn の NavigationMenu は「行き先を持つリンク」を前提にしていて、**遷移しないリンクを押しても開いたまま残る。**プロジェクトを選んでも一覧が居座った。value / onValueChange で開閉を自分で持ち、選択時に空文字へ戻して閉じた — file dashboard/src/components/app-sidebar.tsx
- `e-input-group-has-disabled` 09-08 00:52 [駄目だった道] shadcn の InputGroup は has-disabled:opacity-50 を持っていて、**子孫のどれか 1 つが disabled だと枠ごと薄くなる。**送信ボタンを「下書きが空なら disabled」にしたところ、書き始める前の入力欄が丸ごと「使えない欄」に見えた。送信ボタンだけ disabled をやめ、aria-disabled と pointer-events-none にした — file dashboard/src/components/ui/input-group.tsx
- `e-no-project-identity` 09-08 01:00 [判明したこと] 「このプロジェクトは何か」に答えられなかった原因は、**DB に mitos の定義がどこにも無いこと**だった。record は 1 件（personal-rebuild）で、それは作業のセッション記録。scope.role と scope.summary は 2 リポジトリとも null で、プロンプトの『いま見ている範囲』が `- iroha924/mitos` としか出ていなかった。役割と一行説明を入れる mitos describe コマンドは前から存在するが、一度も実行されていない — $ curl -s localhost:8787/api/scopes (exit 0) / file server/src/cli.ts
- `e-title-latency` 09-08 01:02 [意図して残した負債] 会話の題を LLM に付けさせるため、答えを流し終えてから saved を返すまでに 1.7〜2.5 秒かかる。**その間、送信ボタンは「止める」のまま。**非同期にする案は、busy の解除が SSE の切断に紐づいているせいで結局待たせるので採らなかった。直すなら done イベントで busy を落とす配線が要る — $ python3 ask.py (exit 0)
- `e-session-commits` 09-08 01:10 [状態の変化] この回のコミットは 904cd60 から 15c3423 までの 35 本（前回の記録は 357aa22 までを含む）。ブランチは main。**push はしていない** — $ git log --format='%h|%ad|%s' --date=short -43 (exit 0)
- `e-extra-material-none` 09-08 01:11 [作業] 記録を書く前に「記録に入れておきたいものは他にありますか。（会話に出ていない口頭の判断、別のメモ、次にやるつもりのことなど）」と 2 回聞いた（この回と、地図の削除前の回）。回答はそれぞれ「特に無い。会話から書いて」「無い。会話の内容だけでいい」で、**追加素材は未提供。**したがってこの記録は transcript と git 履歴だけから書いている — $ node /Users/shunichi/Projects/mitos/plugin/skills/trace/bin/progress.mjs collect --out digest.json (exit 0)
- `e-graph-deps-stale` 09-08 02:00 [判明したこと] **地図を消したことで、地図を前提にした過去のエントリが再現できなくなっている。**レビュアーの指摘（#4）で洗い出した。確かめ方が /api/graph の戻り値に乗っている決定が 2 件（d-edges-from-parent-and-ref、d-ref-as-hub）、その検証が 3 件（v-edge-kinds、v-graph-edges、v-citation-map）。いずれも [pass] のまま残っているが、**いま再実行する手段は無い。**「確認済みで維持されている」と読まないこと。同様に q-force-layout-scale の力学配置、用語「結び目」、e-click-coordinate と e-label-collapse が指す dashboard/src/components/graph.tsx も、いまのツリーには存在しない — $ grep -rn 'graph' dashboard/src server/src -i (exit 0)
- `e-scratchpad-not-tracked` 09-08 02:00 [判明したこと] **再現手段として書いたスクリプトのうち、いま存在しないものがある。**レビュアーの指摘（#6・#17）で確かめた。scratchpad/ は git 管理下に 1 件も無く、ディレクトリ自体が存在しない（v-purge と e-purge-scope が指す purge.ts / purge2.ts、e-relation-empty の refs.ts などが該当）。この回で書いた .title-cmp.ts（v-title-strategy）と ask.py（v-readme-grounding、e-title-latency）も、測った後に消した一時ファイルで残っていない。**これらの検証は結果だけが残り、再実行できない。** — $ git ls-files scratchpad (exit 0)
- `e-two-scopes` 09-08 02:00 [判明したこと] **作業場所は 2 件ある。**e-purge-scope の「残ったのは 1 件」は削除直後の観測で、そのあと mitos ingest が mitos 自身の作業場所を登録したため増えた（ingest は未登録の作業ディレクトリを登録する）。id 1 が iroha924/hir4ta-developer（node 310・record 2）、**id 19 が iroha924/mitos（node 69・record 1）**。v-now-phases-mismatch の scope_id = 19 は mitos を指す — $ select id, label, count(node), count(record) from scope (exit 0)
- `e-counts-differ-by-population` 09-08 02:00 [判明したこと] **node の件数が 310 / 330 / 379 と揺れて見えるのは母数が違うため。**レビュアーの指摘（#10）で確かめた。310 は hir4ta-developer だけの node、379 は 2 作業場所の合計（310 + 69）、330 は地図の節数で、node に結び目として置いた PR とファイル 20 件を足したもの。一方 **bot 発言を「139 件」と書いたのは誤りで、実測は 138 件**（d-exclude-bot-utterances の結果欄）。同じ決定の文脈に書いた 138 が正しい — $ select count(*) from node where kind='utterance' and deleted_at is null and (attrs->>'authors') ilike '%[bot]%' (exit 0)
- `e-whisper-provenance-lost` 09-08 02:00 [判明したこと] [inference] **d-whisper-1 が手元モデルを棄却した数字の出所を、いまは切り分けられない。**レビュアーの指摘（#9）。同じ比較の周辺で 2 つの事故が起きている — e-nt-drops-tail（-nt が末尾を落とす。モデルの性質だと誤診断した）と e-zsh-word-split-again（比較スクリプトが前回の出力を読み、数字が前の実行のものだった）。「50.6 秒を 20.7 秒で打ち切った」がこの 2 つより前か後かは記録に無く、音声と実行体も残っていない（e-scratchpad-not-tracked）。**手元モデルへ戻す判断をするなら測り直しが要る。**なお whisper-1 を採った側の根拠（誤変換 0、末尾が落ちない）はこの回でも API 経由で再現できる — file personal-rebuild.progress.md
- `e-routes-now` 09-08 02:00 [判明したこと] **いまの画面は 6 本。**レビュアーの指摘（#12）で数えた。/（質問する）、/now（作業の現在地）、/search（記録を探す）、/records/$id（記録）、/mtg（会議を聞き取る）、/settings（設定）。背景に書いた 8 本のうち /chat は / に統合、/projects と /terms は /settings のタブへ、/people（名簿）と /advice（編集時の助言）は 38d9fa4 で削除した — $ ls dashboard/src/routes/ (exit 0)
- `e-review-triage-2` 09-08 02:10 [作業] まっさらなレビュアー 1 体に .md だけを渡し、23 件の指摘を全件裁定した（1 ラウンドで打ち切り）。**受理して直した 13 件**: 目的が削除済みの地図を完了条件に要求したままだった（d-goal-after-map）、push 範囲がリモートの実体と食い違っていた（v-remote-head。リモートは 8e3942f ではなく 357aa22 だった）、地図に依存する決定 2 件と検証 3 件が再実行できないまま [pass] で残っていた（e-graph-deps-stale）、再現手段のスクリプトが git に無い・消してある（e-scratchpad-not-tracked）、作業場所が 1 件か 2 件か（e-two-scopes）、node の件数の母数と bot 発言 139→138 の誤り（e-counts-differ-by-population、v-bot-utterances）、relation の書き手が無いという断定が未検証だった（v-relation-no-writer）、会議の聞き取りを grep でしか確かめていない（v-mtg-end-to-end を not-run で明示）、緑の証拠が 35 本前の時点だった（v-green-at-head）、SessionEnd の一次ソースに URL と参照日が無い（v-hook-doc）、書体の決定が無い（d-geist-murecho）、画面が何本か特定できない（e-routes-now）、whisper の棄却根拠の出所が切り分けられない（e-whisper-provenance-lost）、再接続中の音声欠落と scrub パターンの所在が未解決に入っていなかった（q-realtime-gap、q-scrub-pattern）。**見送った 8 件と理由**: (a) 正本が html か md かの食い違いと実行体パスの二重表記は、記録の本文ではなく trace の書き出しテンプレートが出している文言なので記録側で直せない（証拠の相対パス 1 件だけ直した）。(b)「方向を選ぶ」「画面の展開」に決定が無いのは、どちらも本人の直接の指示で棄却案が存在しないため。(c) /advice と /mtg を足した決定が無いのも同じ理由（画面の一覧は e-routes-now で確定させた）。(d) v-int-casts の what が観測より強い点は、e-bigint-as-string 自身が走査範囲の限界を書いており記録内で矛盾していない。(e) v-evals-shell が評価セット 5 本のうち 1 本しか cat していない点は、d-delete-not-scrub の中心根拠ではない。(f) 制約が 8 件と 3 件で食い違って見えるのは母数の違い — e-now-screen-kept の 8 件は /now 画面が集約して出す件数（制約 + やらないこと + 行き止まり）で、background.constraints の 3 件とは別物。(g) q-title-backfill の「ChatGPT は過去の会話名を変えない」に出典が無い点は、人への問いに添えた判断材料であって事実の主張として使っていない。(h) e-purge-timeout の ROLLBACK 後に件数を数え直していない点は、そのあと e-purge-scope で削除を完了して数え直しており、いまの DB 状態は独立に確かめられている。**なお指摘 #22 は見送らず、ここに書き残す** — 「回答精度 74/74」の出所はこの記録の外（削除済みの MEMORY.md）にあり復元できない。数値として引かないこと。「Google Meet 6 割・Zoom 2 割・Teams 2 割」は本人の申告で、実測ではない — file personal-rebuild.progress.md
- `e-favicon-was-template-leftover` 09-08 02:40 [判明したこと] dashboard/public に置いてあった favicon.svg（紫の稲妻）と icons.svg（Bluesky などの SNS アイコン束）は**index.html からどこからも参照されていなかった。**テンプレート由来の残骸で、実質ファビコンは未設定だった。icons.svg は削除し、favicon.svg は中身を差し替えた — $ grep -rn 'favicon|icons.svg' --include='*.html' --include='*.tsx' . (exit 0)
- `e-push-2` 09-08 03:00 [状態の変化] **この回の 37 コミットを origin/main へ push した。**リモートは 357aa22 から a9decb4 へ進んだ。先頭は 904cd60（地図の削除）、末尾は a9decb4（アイコン「折り返す糸」）。push の前に型検査・整形・テスト 42 件・本番ビルド・bundle（mcp.js / hook-check-path.js / cli.js）を通してある — $ git push origin main (exit 0) / $ git ls-remote origin refs/heads/main (exit 0)
- `e-describe-rejected-as-design` 09-08 03:20 [判明したこと] **「人が明示する」を次にやることに置いたのが誤りだった。**前の回で `mitos describe` の実行を next へ入れ、hir4ta-developer の説明を本人に求めたが、本人は答えではなく設計を否定した。**聞くべきだったのは「何のリポジトリか」ではなく、「なぜ AI が自分で調べないのか」だった。**手元には材料が揃っていた（scope.abs_path が入っていて read_code と grep_code が使える）ので、実装の障害は無い — $ select id, label, role, summary, abs_path from scope order by id (exit 0)
- `e-choices-wording` 09-08 03:25 [作業] 記録の漏れ検査（cover）が、聞いた問いの文言と記録の文言が違うだけで「落ちている」と出すことがある。「この記録に入れておきたいものは他にありますか。会話に出ていない口頭の判断や、次にやるつもりのことがあれば拾います。」への回答「特に無い。会話から書いて」は e-extra-material-none に入れてあるが、問いを言い換えて書いたため突き合わせに当たらなかった。**問いは言い換えずそのまま写す。** — $ node bin/progress.mjs cover digest.json ir.json (exit 1)
- `e-corrections-round2` 09-08 03:45 [判明したこと] 2 巡目のレビューで、**この回に自分が書いた記録の誤りが 6 件**見つかった。過去のエントリは書き換えないので、ここに正を置く。(1) `e-favicon-was-template-leftover` の根拠コマンドは `grep -rn 'favicon|icons.svg'` で、**-E が無いので `|` が選択にならず、literal 文字列を探していた。**しかも grep の exit 0 は「一致あり」なので、記録した終了コードは主張と逆向きに読める。正しい形は `grep -rEn 'favicon|icons\.svg' --include='*.html' --include='*.tsx' --include='*.ts' dashboard/src dashboard/index.html`。(2) `d-focus-no-ring` の観測時点 03:25 は**記録を書いた時刻**で、判断した時刻ではない（コミット 810615c の時刻が実際）。そのせいで「push 済み（a9decb4）」と矛盾して見える。**810615c は a9decb4 の祖先で、push 済みである**（git merge-base --is-ancestor で確認）。(3) `d-focus-no-ring` の確かめ方のパス `src/components/ui/` は `dashboard/src/components/ui/` の誤り。(4) 同じ決定の「サイドバー 7 箇所」は **6 箇所**の誤り（grep -c で実測）。ファイルは dashboard/src/components/ui/sidebar.tsx。(5) `e-push-2` と `v-pushed` の「リモートは a9decb4」は、その後 1a9dae7 を push したので**古い**。(6) `d-infer-project-identity` の結果欄は**まだ起きていないことを断定形で書いている**（v-identity-auto が not-run なのと食い違う）。「JARVIS の側へ 1 歩寄る」「使えるようになる」は達成ではなく**狙い**として読むこと — $ git merge-base --is-ancestor 810615c origin/main (exit 0) / $ grep -c focus-visible:bg-sidebar-accent dashboard/src/components/ui/sidebar.tsx (exit 0)
- `e-icon-png-recipe` 09-08 03:45 [作業] アプリアイコンの PNG は SVG から書き出している。**形を変えたら 2 枚を揃え直す必要があるので手順を残す。**180x180 の外枠に #2c2c2b の矩形を敷き、その中へ 112x112 の入れ子 svg として同じマークを白（#fdfdfd）で置き、`rsvg-convert -w 180 -h 180 <その svg> -o dashboard/public/apple-touch-icon.png` で変換する。**明暗の追随は SVG 側だけ**で、PNG は暗い地に固定（iOS が透過を扱わないため） — $ rsvg-convert -w 180 -h 180 mitos-app-icon.svg -o apple-touch-icon.png (exit 0)
- `e-review-triage-3` 09-08 03:45 [作業] 2 巡目のレビュー 22 件を裁定し、**ここで打ち切った**（同じ変更へのレビューは 2 ラウンドまで）。**受理して直した**: 上の 6 件の誤り（e-corrections-round2）、PNG の再生成手順（e-icon-png-recipe）、用語集が `undefined` で出ていた件、棄却済みの設計を未解決の問いに残していた件（q-scope-summary → q-identity-scope へ寄せた）、検証が読んだ値を残していなかった 4 件（v-pushed-2 / v-icon-shape / v-focus-values / v-green-at-push）、サイドバーの変更が宙に浮いていた件（q-sidebar-focus-bg）、いまここが期限付き未決を隠していた件。**見送った**: (a) `d-infer-project-identity` が未確定のまま accepted である点 — **方針の決定と実装の決定を分けている。**採ったのは「人に書かせない」であって「取り込み時に読む」ではない。確かめ方が取り込み時に倒れているのは書き方の問題なので、q-identity-scope が決着したときに実装側の決定を別 id で立てる。(b) 読む順が決定の結果欄と q-identity-scope で違う点 — どちらも未決の例示で、決めるのは次のセッション。(c) 「折り返す糸」の棄却理由が本人の選択である点 — **4 案とも 16px の条件は満たしていた。**最後は本人の好みで決まっており、それ以上の理由は無い。無いものを書かない。(d) 初見の人に見せていない点 — 見せる相手がいない。(e) `e-choices-wording` の適用先が無い点 — 規範として残すだけで足り、道具を直すかは別の作業。(f) v-remote-head と v-pushed の重複 — 起点が違う別の観測で、v-pushed-2 が最新であることを明記した — file personal-rebuild.progress.md

## 検証

- `v-purge` [pass] 会社側の作業場所を消したあと、他の scope の node と record が 1 件も残らず、名簿が本人のみになる — `node scratchpad/purge2.ts`
- `v-scrub` [pass] 追跡ファイルに、組織名・リポジトリ名・チーム名・issue 番号・実名・ハンドルが 1 件も残らない — `git grep -ilE '<組織名・リポジトリ名・チーム名・issue の接頭辞・実名・ハンドルの列挙>' -- .`
- `v-graph-edges` [pass] 地図の辺が両端とも返した節に含まれ、片側だけの辺が出ない。あわせて辺を持たない節が 84 / 330 件（25%）で 3 割未満であること （d-ref-as-hub を確かめた） — `curl -s 'http://localhost:8787/api/graph?scopes=1&kinds=all' | python3 -c "..."`
- `v-citation-map` [pass] 質問の答えの引用番号と、地図で光る節のバッジが一致する — `ブラウザで「何を試して駄目だった？」を送信し、答えの箇条書きと地図のバッジを目視で突き合わせた`
- `v-checks` [pass] 型検査・整形・テスト 42 件・本番ビルドがすべて通る（2026-09-07 16:00、push の直前） — `bun run check && bun run test && bun run build`
- `v-relation-writer` [not-run] relation 表に書き込む経路が存在するかどうか (未実行: 表が 0 行であることは確認したが、書き手が無いことをコード全体の走査では確かめていない。ingest 側に書く経路が眠っている可能性は排除できていないため、d-edges-from-parent-and-ref はこの点を前提にしていない（0 行という観測だけで足りる）)
- `v-edge-kinds` [pass] 地図の辺が rejected / considered / belongs の 3 種だけで、rejected と considered の合計が node.parent_id の件数と一致する （d-edges-from-parent-and-ref を確かめた） — `curl -s 'http://localhost:8787/api/graph?scopes=1' | python3 -c "import json,sys,collections; d=json.load(sys.stdin); print(dict(collections.Counter(e['kind'] for e in d['edges'])))"`
- `v-private-repo` [pass] リポジトリが private であること（isPrivate true を確認）。履歴を書き換えない判断がここに依存している （d-keep-git-history を確かめた） — `gh repo view iroha924/mitos --json visibility,pushedAt,isPrivate`
- `v-route-tree` [pass] 記録の一覧ルートが消え、詳細ルートだけが残っている （d-keep-now-screen を確かめた） — `grep -n records dashboard/src/routeTree.gen.ts`
- `v-labels` [pass] サイドバーの項目名とヘッダの見出しが一致し、思想を映した旧名が残っていない （d-concrete-labels を確かめた） — `ブラウザで / を開き、サイドバーとヘッダを目視で突き合わせた`
- `v-no-linear-scope` [pass] Linear の作業場所が DB に残っていない （d-abandon-linear-import を確かめた） — `./plugin/bin/mitos scopes`
- `v-evals-shell` [pass] 評価セットは中身が空で、実行体は残っている（次の職場で問いだけ書けば動く） （d-delete-not-scrub を確かめた） — `cat server/evals/answers.json && ls server/evals/*.ts`
- `v-int-casts` [pass] 地図と検索が画面へ返す id が、すべて数として返る（bigint の文字列が残っていない） — `grep -nE 'n\.id|child\.id|child\.parent_id|r\.id::|Number\(h\.id\)' server/src/http.ts server/src/chat.ts`
- `v-utterance-ratio` [pass] 検索の結果を押しのけていたのが bot の定型文であること — `select kind, count(*) from node where deleted_at is null group by kind`
- `v-now-phases-mismatch` [pass] record.status が phases と同期していないこと — `select id, status, phases from record where scope_id = 19`
- `v-title-strategy` [pass] 会話の題を、質問だけで作る場合と答えも見て作る場合で比べる （d-title-from-answer を確かめた） — `node .title-cmp.ts`
- `v-readme-grounding` [pass] プロジェクトそのものを問う質問に、README を読んで答えるようになったこと （d-readme-for-identity を確かめた） — `python3 ask.py 'このプロジェクトについて2行で教えて'`
- `v-history-collapse` [pass] 会話履歴が 10 件を超えたときに畳まれ、残りも開けること — `SHOWN を 3 に下げて画面を確認し、10 に戻す`
- `v-session-green` [pass] この回の変更で型検査・整形・テスト・本番ビルドが通ること — `bun run check && bun run test && bun run build`
- `v-hook-blocking` [pass] SessionEnd フックが終了を止められないこと（止める案を捨てる根拠） — `Claude Code 公式ドキュメントの hooks 節を読む`
- `v-scope-summary-null` [pass] プロジェクトの定義がプロンプトへ渡っていないこと — `select id, label, role, summary, abs_path from scope order by id`
- `v-graph-gone` [pass] 地図の実装がコードに残っていないこと （d-drop-map を確かめた） — `grep -rn 'graph' dashboard/src server/src --include='*.ts' --include='*.tsx' -i`
- `v-transcribe-whisper1` [pass] /api/transcribe が whisper-1 を呼び、ffmpeg にも分割処理にも依存していないこと （d-whisper-1 を確かめた） — `grep -n 'whisper-1\|ffmpeg\|chunk' server/src/http.ts`
- `v-two-streams` [pass] 会議の聞き取りが 2 系統を別々に流していること （d-two-streams-not-diarization を確かめた） — `grep -n 'listen(' dashboard/src/routes/mtg.tsx`
- `v-realtime-raw-ws` [pass] Realtime へ素の WebSocket で繋いでいて、openai の SDK をブラウザへ入れていないこと （d-realtime-not-chunking を確かめた） — `grep -n 'new WebSocket\|from "openai"' dashboard/src/lib/listen.ts`
- `v-search-excludes-utterance` [pass] 検索が kinds 未指定のとき utterance を除いていること （d-exclude-bot-utterances を確かめた） — `grep -n 'utterance' server/src/search.ts`
- `v-now-sql` [pass] /api/now が status ではなく phases の未完で絞っていること （d-now-by-phases を確かめた） — `grep -n 'jsonb_array_elements(r.phases)' -A 2 server/src/http.ts`
- `v-session-end-silent` [pass] SessionEnd フックが、記録済みのセッションと編集の無いセッションでは黙ること （d-session-end-hint を確かめた） — `3 種類の transcript（trace 起動あり / 編集なし / 編集あり）を stdin から食わせる`
- `v-chat-no-heading` [pass] チャットが記事型（質問が見出し）をやめ、shadcn の部品で組まれていること （d-chat-as-conversation を確かめた） — `grep -c '<h2' dashboard/src/routes/index.tsx; grep -n 'Bubble\|<Message\|<InputGroup' dashboard/src/routes/index.tsx`
- `v-title-in-savetun` [pass] 新規の会話が、題の生成を待ってから作られること （d-title-from-answer を確かめた） — `grep -n 'titleFor(question, answer)' server/src/http.ts`
- `v-system-readme` [pass] システムプロンプトが、プロジェクトの定義を README へ回していること （d-readme-for-identity を確かめた） — `grep -n 'リポジトリに聞く' server/src/chat.ts`
- `v-four-entrypoints` [pass] server/src の入口が 4 つあり、ダッシュボードがそのうち 1 つでしかないこと。Next.js が入っていないこと （d-stay-on-vite-react を確かめた） — `ls server/src/{http,mcp,cli,hook-check-path}.ts dashboard/vite.config.ts && grep -n next dashboard/package.json`
- `v-relation-no-writer` [pass] relation 表へ書き込む経路がリポジトリのどこにも無いこと（v-relation-writer が未実行のまま残していた点） （d-edges-from-parent-and-ref を確かめた） — `grep -rn 'into relation' --include='*.ts' --include='*.sql' --include='*.mjs' . | grep -v node_modules; grep -rln relation server/src`
- `v-bot-utterances` [pass] 検索から外した utterance のうち bot 由来が何件か（v-utterance-ratio の SQL は kind 別の総数しか返しておらず、bot かどうかを示していなかった） （d-exclude-bot-utterances を確かめた） — `select count(*) from node where kind='utterance' and deleted_at is null and (attrs->>'authors') ilike '%[bot]%'`
- `v-remote-head` [pass] リモートがどこまで進んでいるか（次にやること「push」の範囲） — `git ls-remote origin refs/heads/main && git rev-list --count 357aa22..HEAD`
- `v-routes-count` [pass] 目指すところが要求する「全画面」が何本で、地図が含まれないこと （d-goal-after-map を確かめた） — `ls dashboard/src/routes/`
- `v-mtg-end-to-end` [not-run] 会議の聞き取りが、実際の会議で文字起こしを出し続け、600 秒を越えても鍵の取り直しで止まらないこと （d-realtime-not-chunking を確かめた） (未実行: 会議 1 本を実際に通す以外に確かめる手段が無い。手元に相手の音声が入る画面共有を再現できず、ephemeral token の 600 秒切れも実時間でしか起きない)
- `v-hook-doc` [pass] SessionEnd が終了を止められないという一次ソース（止める案を棄却した根拠） （d-session-end-hint を確かめた） — `https://code.claude.com/docs/en/hooks の SessionEnd 節（2026-09-08 参照）`
- `v-green-at-head` [pass] 最後のコミットを含む状態で、型検査・整形・テスト・本番ビルドが通ること（v-checks は 35 本前の時点、v-session-green は時点も出力も無い） — `bun run check && bun run test && bun run build`
- `v-fonts` [pass] 書体が Geist と Murecho に入れ替わり、丸ゴシックが依存から消えていること （d-geist-murecho を確かめた） — `grep -n 'Geist Variable\|Murecho\|m-plus-rounded' dashboard/src/styles.css dashboard/package.json`
- `v-icon-wired` [pass] ファビコンとアプリアイコンが配線され、どちらも配信されること （d-icon-folded-thread を確かめた） — `ブラウザから fetch('/favicon.svg') と fetch('/apple-touch-icon.png')、link[rel*=icon] を列挙`
- `v-pushed` [pass] リモートがこの回の作業を含んでいること — `git ls-remote origin refs/heads/main && git rev-list --count origin/main..HEAD`
- `v-identity-auto` [not-run] 取り込んだ直後に scope.role と scope.summary が埋まり、README を読み直さずにプロジェクトの定義を答えられること （d-infer-project-identity を確かめた） (未実行: まだ実装していない。この回で決めたのは方針だけで、経路（何を読むか・いつ作るか）は q-identity-scope として未決のまま次のセッションへ渡す)
- `v-focus-no-shadow` [pass] フォーカスしても box-shadow にリングが増えず、枠の色だけが変わること （d-focus-no-ring を確かめた） — `入力欄をクリックしてから getComputedStyle(inputGroup) の boxShadow と borderColor を読む`
- `v-pushed-2` [pass] **この時点で最新の push の観測。**v-pushed と v-remote-head はどちらも古い（それぞれ a9decb4 / 357aa22 起点） — `git ls-remote origin refs/heads/main && git rev-list --count origin/main..HEAD && git rev-list --count 357aa22..HEAD`
- `v-green-at-push` [pass] push の直前に検査が通っていたこと（e-push-2 が根拠を残していなかった） — `bun run check; bun run test; bun run build; bun run bundle`
- `v-icon-shape` [pass] favicon の viewBox と線の太さが、16px で滲まない条件を保っていること（v-icon-wired は配信しか見ていなかった） （d-icon-folded-thread を確かめた） — `grep -o 'viewBox="[^"]*"|stroke-width="[^"]*"' dashboard/public/favicon.svg`
- `v-focus-values` [pass] フォーカス時に読んだ実際の値（v-focus-no-shadow が変更後の値を残していなかった） （d-focus-no-ring を確かめた） — `入力欄をクリックし getComputedStyle(document.querySelector('[data-slot=input-group]')) を読む`
- `v-icon-seen-by-others` [not-run] 「初見では U か釣り針に見える」を、名前を知らない人に見せて確かめる （d-icon-folded-thread を確かめた） (未実行: 見せる相手がいない。個人の道具で、いま使うのは本人だけ。不利として書いてあるのは形からの推論であって観測ではない)

## 用語

- 折り返す糸: mitos の印（ファビコンとアプリアイコン）。縦に伸びた線が下で折り返して途中で止まり、辿り着いた先に点が置かれる形。μίτος はギリシャ語の「糸」で、辿れば元の判断まで戻れることを指す。16px のタブで読めることを第一条件に、線 3 要素すべてを 2 単位の太さで 16 の格子に乗せてある。実体は dashboard/public/favicon.svg（明暗に追随）と apple-touch-icon.png（180x180、暗い地に固定）

## この文書について

`personal-rebuild.progress.html` から生成された投影で、手で編集しても次の書き出しで消える。
書き換えるときは IR を取り出して直し、描き直す。
`node /Users/shunichi/Projects/mitos/plugin/skills/trace/bin/progress.mjs read personal-rebuild.progress.html > ir.json` → 編集 → `node /Users/shunichi/Projects/mitos/plugin/skills/trace/bin/progress.mjs render ir.json`。
