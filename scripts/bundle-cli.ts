// Bundles the CLI (server/src/cli.ts) into the single file plugin/dist/cli.js. scripts/bundle.mjs runs it with bun.
// The CLI draws its output and the dashboard with Ink. With DEV=true and react-devtools-core present, Ink loads ink/build/devtools.js,
// which uses ws and react-devtools-core. devtools.js becomes an empty module so neither goes into the bundle.

import path from "node:path";
import type { BunPlugin } from "bun";

const root = path.resolve(import.meta.dir, "..");

// Emptying only ws and react-devtools-core crashed at startup when DEV=true and react-devtools-core sat in a parent directory,
// because the empty ws was constructed (measured: TypeError: ws_default is not a constructor). Empty devtools.js, the module that loads them
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
