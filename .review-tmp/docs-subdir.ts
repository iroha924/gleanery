import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ingestDocs, markdownFiles, sections, sectionText } from "../server/src/docs.ts";
import { identify } from "../server/src/scope.ts";

const D = "/private/tmp/claude-501/-Users-shunichi-Projects-mitos/4781c103-7960-452c-9449-3cfcead011f3/scratchpad/docsrepo";
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(path.join(D, "docs"), { recursive: true });
fs.mkdirSync(path.join(D, "server"), { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", D, ...a], { stdio: "ignore" });
execFileSync("git", ["init", "-q", D], { stdio: "ignore" });
git("config", "user.email", "t@e.com"); git("config", "user.name", "t");
git("remote", "add", "origin", "https://github.com/o/r.git");
fs.writeFileSync(path.join(D, "README.md"), "# 全体像\nルートの説明\n");
fs.writeFileSync(path.join(D, "docs", "adr.md"), "# 決定\n採用した案\n");
fs.writeFileSync(path.join(D, "server", "NOTES.md"), "# サーバ\nメモ\n");
git("add", "-A"); git("commit", "-qm", "x");

const sub = path.join(D, "server");
console.log("ident(root)   =", identify(D).ident);
console.log("ident(sub)    =", identify(sub).ident, "  <- 同じ record を指す");
console.log("files(root)   =", markdownFiles(D).files);
console.log("files(sub)    =", markdownFiles(sub).files, " <- 根からの相対ではない");

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// 「根から取り込み済み」の DB 状態を作る
const rootKeys: string[] = [];
for (const rel of markdownFiles(D).files)
  for (const s of sections(rel, fs.readFileSync(path.join(D, rel), "utf8")))
    rootKeys.push(s.key);
console.log("DB にある key  =", rootKeys);

// サブディレクトリから import-docs を叩いたとき
const subRows: { key: string; content_hash: string; has_emb: boolean }[] = [];
for (const rel of markdownFiles(sub).files)
  for (const s of sections(rel, fs.readFileSync(path.join(sub, rel), "utf8")))
    subRows.push({ key: s.key, content_hash: hash(sectionText(s)), has_emb: true });

const log: { sql: string; params: unknown[] }[] = [];
const client = {
  async query(sql: string, params: unknown[] = []) {
    log.push({ sql, params });
    if (sql.includes("select key, content_hash")) return { rows: subRows, rowCount: subRows.length };
    if (sql.trimStart().startsWith("update node set deleted_at")) {
      // 実際に DB に居る key のうち、$2 に無いものが墓標になる
      const keep = new Set(params[1] as string[]);
      const doomed = rootKeys.filter((k) => !keep.has(k));
      return { rows: doomed.map(() => ({ n: "1" })), rowCount: doomed.length, doomed } as never;
    }
    return { rows: [], rowCount: 0 };
  },
} as never;

const out = await ingestDocs(client, {} as never, identify(sub).ident, "r", sub, 1);
console.log("\n返り値:", out);
const tomb = log.find((l) => l.sql.trimStart().startsWith("update node set deleted_at"));
console.log("墓標 SQL の keep =", tomb?.params[1]);
console.log("→ 墓標になる key =", rootKeys.filter((k) => !(tomb?.params[1] as string[]).includes(k)));
console.log("\n取り込んだ節の at =", log.filter(l=>l.sql.includes("insert into node")).map(l=>l.params[5]));
