# 検証のしかた

**緑だったことと、検査したことは別である。**このリポジトリで実際に空振りした 4 つを挙げる。

## releaseは分類から始める

配布物へ入る変更では、versionを編集する前に
`bun run release:plan -- --base <前回のrelease commit>`を実行する。表示された種別を変えて扱わない。

- `none`: releaseしない
- `npm-only`: dashboard・Honoだけ。`plugin/package.json`だけを上げ、plugin manifest・marketplace・cacheは動かさない
- `plugin`: MCP・CLI・hook・plugin Skill/Agent・共有moduleを含む。npmと3つのplugin versionを同じ値へ上げる

両方が混じれば`plugin`である。不可逆な操作は自動化せず、cleanなreview済みcommitで
`bun run release:prepare -- --base <前回のrelease commit>`が残したtarballだけをpublishする。

## 実 DB へ繋ぐのは専用の検査レーンだけ

`bun run test` の単体テストは、今後も実 DB と外部 API へ繋がない。**例外は `sql:live` の 1 本だけ**で、
次を全部満たす形でのみ繋いでよい。

- 固定 digest の使い捨て PostgreSQL を検査自身が立て、資格情報をその場で作る
- 画面と CLI は子プロセスで起動し、親が期限と終了を持つ
- 子プロセスの `HOME` を一時ディレクトリへ向ける
- 外部 API の鍵を渡さず、外部 API へ出る経路は実行しない
- Docker が無ければ skip せず落ちる
- `bun run verify` に入れない（CI の Docker のレーンに置く）

下の「22 分終わらなくなった」の原因は本物の DB ではなく、**同じテストプロセスに残った pool と
終了責務の欠落**である。子プロセスなら、その責務を親が外から果たせる。

`HOME` を外すと、検査が持ち主のデータを壊す。実測: `capture flush` が持ち主の `~/.gleanery/spool` を
読み、使い捨ての DB へ送って未送信 4 件を消した。`loadEnv` も `~/.gleanery/env` へ落ちるので、
環境変数から鍵を消すだけでは外部 API を止められない。

## 黙って skip するテストを書かない

前提が無いとき `continue` で飛ばすと、CI では常に飛んで緑になる。前提が無いなら落とす。

実測: 画面のビルド成果物が無ければ飛ばすキャッシュの検査を書いたが、`verify` は `build` より先に
`test` を走らせていたので、一度も動かないまま通っていた。`verify` の順序を `check && bundle && test` に変え（`bundle` が画面も建てる）、
飛ばす代わりに落とすようにして直した。

## テストから本物の DB と外部 API に繋がない

テストは資格情報なしで通す（`.github/workflows/check.yml` も同じ前提で書いてある）。

実測: `/api/projects` を叩く検査を足したら、pool を掴んだまま `server.close()` が返らず
`bun run verify` が 22 分終わらなくなった。middleware の検査なら、どの route にも当たらない綴り
（`/api/__probe__`）で同じ経路を通る。

止めるのは `--test-timeout=60000`（`server/package.json`）で、こちらが正本である。

## kysely のコードは 2 通りで検査する

DB へ繋がないのは同じで、見たいものによって道具が変わる。

`server/test/fake-db.ts` の `fakeDb(respond)` を使う。`respond` が SQL とパラメータと回数を見て、
返す行か投げるエラーを決める。生成された SQL は、返ってきた `calls` で見る。

**`DummyDriver` を行の検査に使わない。**公式 API ページは「execute すると throw する」と書いているが、
0.29.6 の実装は `{ rows: [] }` を返す（`dist/driver/dummy-driver.js`）。行を返さないことに気付かないまま
「空の結果で正しく動いた」と読める。

**SQL を部分一致で判定するときは、更新と読み出しを取り違えないよう順番を決める。**kysely は表名を
`"gleanery"."knowledge_embedding"` の形で統一して出すので、同じ表への `update` が `select` 用の分岐に入る。
実測: 埋め込みの補充のテストで、`store` の UPDATE が読み出しの分岐に食われて件数が 2 倍になった。

パラメータの番号は組み立て側が決める。`$2` のような位置を検査に埋め込まない（移行で 1 度ずれた）。

## 配る物は展開して見る

`plugin/dist` と `plugin/db` は追跡しないので、`git diff` には出ない。`npm pack` して
リポジトリの外へ展開し、中身を数えて起動する。

実測: 配布物に 115 個のフォントと React が入っていたのに、ライセンスの告知に 1 件も載っていなかった。
リポジトリを見ているだけでは気付けない。CI の「配る tarball が自己完結しているか」がこれを見る。
