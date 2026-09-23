// CLI（server/src/cli.ts）を plugin/dist/cli.js の 1 ファイルに束ねる。scripts/bundle.mjs から bun で呼ぶ。
// CLI は出力と dashboard の画面を Ink で描く。Ink は DEV=true で react-devtools-core が見つかると ink/build/devtools.js を
// 読み込み、その中で ws と react-devtools-core を使う。devtools.js を丸ごと空の module にし、2 つを束に入れない。

import path from "node:path";
import type { BunPlugin } from "bun";

const root = path.resolve(import.meta.dir, "..");

// ws と react-devtools-core だけを空にすると、DEV=true で react-devtools-core が上の階層に在る環境では、空の ws を
// new して起動ごと落ちた（実測: TypeError: ws_default is not a constructor）。読み込む側の devtools.js ごと空にする
const stub: BunPlugin = {
  name: "stub-devtools",
  setup(b) {
    b.onResolve({ filter: /^\.\/devtools\.js$/ }, (a) =>
      /[\\/]ink[\\/]build[\\/]/.test(a.importer) ? { path: a.path, namespace: "stub" } : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export {};", loader: "js" }));
  },
};

const out = await Bun.build({
  entrypoints: [path.join(root, "server/src/cli.ts")],
  target: "node",
  outdir: path.join(root, "plugin/dist"),
  naming: "cli.js",
  plugins: [stub],
});
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}
