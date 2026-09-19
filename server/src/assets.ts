// 実行時に読む同梱物（画面のビルド成果物、DB の schema と compose）の在り処。
//
// **cwd から探さない。**フックは編集中のプロジェクトを cwd として起動し、CLI はどこからでも叩かれる。
// 基準は常に、いま動いているこのファイルの位置である。
//
// 置かれ方は 2 つある。
//   配る形    <package>/dist/cli.js から見て <package>/dist/dashboard と <package>/db
//   作業ツリー server/src/assets.ts から見て dashboard/dist と db
// **画面と DB で基準からの深さが違う。**画面は dist の下に束ねるが、DB は package.json の files が
// <package>/db へ置くので、dist から 1 つ上がる。同じ候補を使い回すと、作業ツリーではリポジトリ直下の
// db に当たって通り、配った先だけで壊れる。
// bun build は import.meta.url を実行時の値に解決するので、束ねた後も自分の位置が分かる。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = (): string => path.dirname(fileURLToPath(import.meta.url));

/** 候補を順に見て、目印のファイルがある最初のものを返す。 */
function locate(marker: string, candidates: string[]): string | null {
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
  }
  return null;
}

/** 画面のビルド成果物。無ければ null（開発では build 前に CLI を叩くことがある）。 */
export const dashboardRoot = (from = here()): string | null =>
  locate("index.html", [path.join(from, "dashboard"), path.join(from, "..", "..", "dashboard", "dist")]);

/**
 * DB の同梱物（schema.sql、migrations、compose.yaml）。
 * **見つからないなら投げる。**黙って既定へ倒すと、空の schema を当てたように見えてしまう。
 */
export function dbDir(from = here()): string {
  const dir = locate("schema.sql", [path.join(from, "..", "db"), path.join(from, "..", "..", "db")]);
  if (!dir) {
    throw new Error("DB の同梱物（db/schema.sql）が見つからない。配布物が壊れているか、bundle していない");
  }
  return dir;
}
