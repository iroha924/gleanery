#!/usr/bin/env node
// untrusted な文章を読むインターフェース（MCP・端末の画面）が、書く接続（server/src/db-write.ts）を持たないことを見る。
//
// **接続の役割は import の向きで分ける。**読むインターフェースの entry から import を辿って db-write.ts に届けば、読んだ文章に
// 唆されて書く経路ができる（CLAUDE.md・AGENTS.md の実行境界）。型でも authorizer でも止まらない — 書く接続を開いてしまえば、
// authorizer はその役割の書き込みを許す。

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
/** 読むだけのインターフェース。ここから辿れる module は書く接続を import してはいけない。 */
const READERS = ["server/src/mcp.ts", "server/src/tui/tui.ts"];
const WRITER = "server/src/db-write.ts";

// `import x from`・`export ... from`・副作用だけの `import "..."`・`import(...)` の 4 つの形。
const IMPORT =
  /(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|import\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;
const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");

/** entry から辿れる module と、それぞれを最初に import した module。 */
function reach(entry) {
  const via = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const next = rel(path.resolve(path.dirname(path.join(root, file)), spec));
      if (!next.startsWith("server/src/") || via.has(next)) continue;
      via.set(next, file);
      queue.push(next);
    }
  }
  return via;
}

const fail = [];
for (const entry of READERS) {
  if (!fs.existsSync(path.join(root, entry))) {
    fail.push(`${entry} が無い。check-architecture.mjs の READERS を直す`);
    continue;
  }
  const via = reach(entry);
  if (!via.has(WRITER)) continue;
  const chain = [];
  for (let at = WRITER; at; at = via.get(at)) chain.unshift(at);
  fail.push(`${entry} から書く接続へ届く: ${chain.join(" → ")}`);
}
// 辿る正規表現が壊れて 1 つも拾わなくなると、何も見ないまま通る。entry が src の module を import していることを見る。
for (const entry of READERS)
  if (fs.existsSync(path.join(root, entry)) && reach(entry).size < 3)
    fail.push(`${entry} の import を辿れていない`);

if (fail.length) {
  console.error(`読むインターフェースの境界:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
const count = new Set(READERS.flatMap((e) => [...reach(e).keys()])).size;
console.log(
  `読むインターフェースの境界: ${READERS.join(" / ")} から辿れる ${count} module は書く接続を import していない`,
);
