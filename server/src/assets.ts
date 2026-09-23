// 実行時に読む同梱物（DB の schema と migrations）の在り処。
//
// **cwd から探さない。**フックは編集中のプロジェクトを cwd として起動し、CLI はどこからでも叩かれる。
// 基準は常に、いま動いているこのファイルの位置である。
//
// 置かれ方は 2 つある。
//   配る形    <package>/dist/cli.js から見て <package>/db（package.json の files が dist の隣へ置く）
//   作業ツリー server/src/assets.ts から見て リポジトリ直下の db
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

/**
 * DB の同梱物（schema.sql と、あれば migrations）。
 * **見つからないなら投げる。**黙って既定へ倒すと、空の schema を当てたように見えてしまう。
 */
export function dbDir(from = here()): string {
  const dir = locate("schema.sql", [path.join(from, "..", "db"), path.join(from, "..", "..", "db")]);
  if (!dir) {
    throw new Error("DB の同梱物（db/schema.sql）が見つからない。配布物が壊れているか、bundle していない");
  }
  return dir;
}
