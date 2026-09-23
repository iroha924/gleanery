// 子プロセスが実際に踏んだ行を V8 のカバレッジから読む。
//
// 子プロセスの中で走った SQL は、親から数えられない。かわりに
// `NODE_V8_COVERAGE` を読む。Node は型注釈を消すだけで位置をずらさないので、`.ts` のまま
// 行番号が一致する（実測: 4 行目の関数が 4-6 行として count=0 で出た）。

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/** その行の、空白でない最初の文字のバイト位置。範囲の内側判定にこれを使う。 */
function offsetOfLine(text, line) {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf("\n", at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  const end = text.indexOf("\n", at);
  const body = text.slice(at, end < 0 ? undefined : end);
  const lead = body.length - body.trimStart().length;
  return body.trim() === "" ? -1 : at + lead;
}

/**
 * `covDir` 以下のカバレッジを読み、`sites`（`server/src/foo.ts:12`）のうち実際に踏んだものを返す。
 *
 * 範囲は入れ子になる。**いちばん内側の範囲で数える** —— 外側の関数が 1 回呼ばれていても、
 * 中の分岐が 0 回なら踏んでいない。広い方を採ると、通っていない行を通ったと数える。
 */
export function coveredSites(covDir, root, sites) {
  const byFile = new Map();
  for (const site of sites) {
    const i = site.lastIndexOf(":");
    const file = site.slice(0, i);
    byFile.set(file, [...(byFile.get(file) ?? []), Number(site.slice(i + 1))]);
  }

  const source = new Map();
  const offsets = new Map();
  for (const [file, lines] of byFile) {
    const abs = path.join(root, file);
    const text = fs.readFileSync(abs, "utf8");
    source.set(abs, text);
    for (const line of lines) offsets.set(`${file}:${line}`, offsetOfLine(text, line));
  }

  // site ごとに、いちばん内側の範囲の count を集める。同じファイルが複数のプロセスで実行されるので、
  // どれか 1 つでも count > 0 なら踏んだものとする。
  const best = new Map();
  if (!fs.existsSync(covDir)) return new Set();
  for (const name of fs.readdirSync(covDir)) {
    if (!name.endsWith(".json")) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(covDir, name), "utf8"));
    } catch {
      continue; // 書き出し途中のファイル
    }
    for (const entry of doc.result ?? []) {
      if (!entry.url?.startsWith("file://")) continue;
      const abs = url.fileURLToPath(entry.url);
      if (!source.has(abs)) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      for (const line of byFile.get(rel) ?? []) {
        const site = `${rel}:${line}`;
        const at = offsets.get(site);
        if (at < 0) continue;
        let inner = null;
        for (const fn of entry.functions ?? []) {
          for (const r of fn.ranges ?? []) {
            if (r.startOffset <= at && at < r.endOffset) {
              if (!inner || r.endOffset - r.startOffset < inner.endOffset - inner.startOffset) inner = r;
            }
          }
        }
        if (inner && inner.count > 0) best.set(site, true);
      }
    }
  }
  return new Set([...best.keys()]);
}
