import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { KyselyPlugin } from "kysely";
import {
  collectDocs,
  commitOf,
  docHash,
  excludedOf,
  isAncestor,
  projectDocs,
  sections,
  syncDocs,
} from "../src/docs.ts";
import { sha256 } from "../src/text.ts";
import { insert, project, type TempDb, tempDb } from "./temp-db.ts";
import { put, withRepo } from "./temp-repo.ts";

// **A `#` inside a code fence is not a heading.** Splitting at a shell comment would separate
// an explanation from the command it describes.
test("does not split at a heading inside a code fence", () => {
  const out = sections(
    "a.md",
    ["## 使い方", "", "```bash", "# これはコメント", "run --now", "```", "", "続き"].join("\n"),
  );
  assert.equal(out.length, 1);
  assert.match(out[0]?.text ?? "", /# これはコメント/);
  assert.match(out[0]?.text ?? "", /続き/);
});

// Treating 3 backticks inside a 4-backtick example as the close would turn headings in the example into sections.
test("a fence closes only on a line with the same character, at least the same length, and no info", () => {
  const md = ["## 書き方", "````md", "```ts", "# 例の中の見出し", "```", "````", "", "## 次", "本文"].join(
    "\n",
  );
  const out = sections("a.md", md);
  assert.deepEqual(
    out.map((s) => s.title),
    ["書き方", "次"],
  );
  assert.equal(sections("b.md", ["## a", "```ts", "```ts", "# 中", "```"].join("\n")).length, 1);
});

test("handles tilde fences", () => {
  const out = sections("a.md", ["## 節", "~~~", "### 中の見出し", "~~~"].join("\n"));
  assert.equal(out.length, 1);
});

// **The same heading appears many times in one file.** A key collision makes the later section win on
// unique (record_id, kind, key), and the earlier one silently disappears.
test("sections with the same heading get distinct keys", () => {
  const out = sections("a.md", ["## 背景", "いち", "## 判断", "に", "## 背景", "さん"].join("\n"));
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((s) => s.key)).size, 3);
});

// The children hold the content. The heading stays in the children's trail, so dropping it loses nothing.
// If a numbered key equals another heading, one upsert gets the same key twice and the whole sync fails.
test("a numbered section key does not collide with a heading of the same text", () => {
  const out = sections("x.md", ["## 背景", "a", "## 背景", "b", "## 背景:2", "c"].join("\n"));
  assert.equal(new Set(out.map((s) => s.key)).size, out.length, out.map((s) => s.key).join(" / "));
});

test("drops sections that are only a heading", () => {
  const out = sections("a.md", ["## 親", "", "### 子", "中身"].join("\n"));
  assert.deepEqual(
    out.map((s) => s.title),
    ["子"],
  );
  assert.match(out[0]?.trail ?? "", /親 > 子/);
});

// The original cannot be fetched again once the repository is gone. Cutting it off loses it for good.
test("a long section continues in the next part instead of being cut", () => {
  const body = Array.from({ length: 60 }, (_, i) => `段落${i}。${"あ".repeat(200)}`).join("\n\n");
  const out = sections("a.md", `## 長い節\n\n${body}`);
  assert.ok(out.length > 1, "not split");
  for (const s of out) assert.ok(s.text.length <= 4000, `a section has ${s.text.length} characters`);
  const joined = out.map((s) => s.text).join("");
  assert.ok(joined.includes("段落0"), "the start was lost");
  assert.ok(joined.includes("段落59"), "the end was lost");
});

// A section alone does not say what it is about. The heading (weighted 3x in the full-text index) is prefixed with the document and section.
test("a section heading is prefixed with its document and section path", () => {
  const out = sections("docs/adr/0001-x.md", ["# 決定", "## Context", "背景の説明"].join("\n"));
  const s = out.find((x) => x.title === "Context");
  assert.ok(s);
  assert.equal(s.trail, "docs/adr/0001-x.md > 決定 > Context");
  assert.equal(s.text, "## Context\n背景の説明");
});

// Documents without headings (a README intro only, a CLAUDE.md with just `@AGENTS.md`) are kept too.
test("a body without headings becomes one section", () => {
  const out = sections("CLAUDE.md", "@AGENTS.md\n");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.text, "@AGENTS.md");
  assert.equal(out[0]?.key, "doc:CLAUDE.md#claude.md");
});

// **Following a tracked symlink would store files outside the repository as body text.**
// In a commit tree a symlink is an entry with mode 120000, and a directory symlink's target is not in the tree at all.
// Users run the import but often do not read its output. A hole here would leak credentials unnoticed.
test("reads from the commit tree and does not include symlink targets", async () => {
  await withRepo((repo, git) => {
    put(repo, "docs/real.md", "# 本物\n中身\n");
    fs.symlinkSync("../../outside.env", path.join(repo, "docs", "leak.md"));
    fs.symlinkSync("../outside.env", path.join(repo, "dirlink"));
    git("add", "-A");
    git("commit", "-qm", "x");
    const { docs, skipped } = collectDocs(repo, commitOf(repo, false));
    assert.deepEqual(
      docs.map((d) => d.path),
      ["docs/real.md"],
    );
    assert.equal(skipped, 1);
    assert.ok(!JSON.stringify(docs).includes("SECRET_TOKEN"));
  });
});

// Not every tracked Markdown file states facts. Audit fixtures are deliberately broken samples, and
// importing them ranks made-up rules above real procedures (measured: bloated/CLAUDE.md in iroha924/hir4ta-developer).
test("does not import excluded files and directories", async () => {
  await withRepo((repo, git) => {
    put(repo, "README.md", "# 本物\n中身\n");
    put(repo, "evals/how-to-run.md", "# 回し方\n残す\n");
    put(repo, "evals/fixtures/bloated.md", "# 架空\n嘘の規約\n");
    put(repo, "evals/fixtures/deep/more.md", "# 深い\n嘘\n");
    put(repo, "evals/fixtures-old/keep.md", "# 別\n残す\n");
    put(repo, "assets/skeleton.md", "# TODO\nTODO\n");
    put(repo, "assets/skeleton.md.bak.md", "# 似た名前\n残す\n");
    git("add", "-A");
    git("commit", "-qm", "x");
    const { docs } = collectDocs(repo, commitOf(repo, false), {
      files: ["assets/skeleton.md"],
      directories: ["evals/fixtures"],
    });
    assert.deepEqual(docs.map((d) => d.path).sort(), [
      "README.md",
      "assets/skeleton.md.bak.md",
      "evals/fixtures-old/keep.md",
      "evals/how-to-run.md",
    ]);
  });
});

// Reading the working tree would put unfinished text into the database.
test("ignores uncommitted edits in the working tree and reads only committed text", async () => {
  await withRepo((repo, git) => {
    put(repo, "README.md", "# 読んで\n公開した本文\n");
    git("add", "-A");
    git("commit", "-qm", "x");
    const head = commitOf(repo, false);
    put(repo, "README.md", "# 読んで\n書きかけ\n");
    const { docs } = collectDocs(repo, head);
    assert.match(docs.find((d) => d.path === "README.md")?.body ?? "", /公開した本文/);
  });
});

// Keep drafts left in the old requirements and design folder out of search. The shipped name is held as a hash, so a stand-in
// directory checks the matching, and the real hash is checked to leave ordinary dot-directories alone.
test("never imports a draft directory at any depth, and checks fast-forward by ancestry", async () => {
  await withRepo((repo, git) => {
    put(repo, ".drafts/project.json", "{}");
    put(repo, ".drafts/changes/a/requirements.md", "# 要件\n下書き\n");
    put(repo, "sub/.drafts/changes/x/design.md", "# 入れ子\n下書き\n");
    put(repo, "docs/.drafts.md", "# 名前が似ているだけ\n本文\n");
    put(repo, ".sphica/notes.md", "# 下書きの場所ではない\n本文\n");
    put(repo, "README.md", "# 読んで\n本文\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const first = commitOf(repo, false);
    const paths = (dirs?: string[]) =>
      collectDocs(repo, first, undefined, dirs)
        .docs.map((d) => d.path)
        .sort();
    assert.deepEqual(paths([sha256(".drafts").toString("hex")]), [
      ".sphica/notes.md",
      "README.md",
      "docs/.drafts.md",
    ]);
    assert.deepEqual(
      paths(),
      [
        ".drafts/changes/a/requirements.md",
        ".sphica/notes.md",
        "README.md",
        "docs/.drafts.md",
        "sub/.drafts/changes/x/design.md",
      ],
      "the shipped hash matches none of these names",
    );
    put(repo, "README.md", "# x\n");
    git("add", "-A");
    git("commit", "-qm", "b");
    const second = commitOf(repo, false);
    assert.equal(isAncestor(repo, first, second), true);
    assert.equal(isAncestor(repo, second, first), false);
    assert.equal(isAncestor(repo, "0".repeat(40), second), false, "a commit not in this clone");
  });
});

test("documents with an uppercase extension also get a last-modified date", async () => {
  await withRepo(async (repo, git) => {
    put(repo, "README.MD", "# 読んで\n本文\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const { docs } = collectDocs(repo, commitOf(repo, false));
    assert.ok(docs.find((d) => d.path === "README.MD")?.at, "README.MD has no date");
  });
});

// Exclusions belong to the docs connector. The sync reads them outside the transaction and applies them before reading blobs.
test("exclusions are read from the docs connector and split into files and directories by kind", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    assert.deepEqual(
      await excludedOf(db.reader, p),
      { files: [], directories: [] },
      "works before the connector exists",
    );
    const docs = insert(db, "connector", { project_id: p, provider: "docs" });
    insert(db, "docs_exclude", { connector_id: docs, kind: "file", path: "assets/skeleton.md" });
    insert(db, "docs_exclude", { connector_id: docs, kind: "directory", path: "evals/fixtures" });
    const other = project(db, "git:github.com/o/other", "o/other");
    const theirs = insert(db, "connector", { project_id: other, provider: "docs" });
    insert(db, "docs_exclude", { connector_id: theirs, kind: "file", path: "theirs.md" });
    assert.deepEqual(await excludedOf(db.reader, p), {
      files: ["assets/skeleton.md"],
      directories: ["evals/fixtures"],
    });
  } finally {
    await db.done();
  }
});

/**
 * A database whose docs connector holds only head. onRead runs once, right when the connector is read
 * (reproducing another sync storing a newer commit in between).
 */
function headOnly(db: TempDb, p: number, head: string, onRead: () => void = () => {}) {
  db.owner
    .prepare(
      "insert into connector (project_id, provider, head_oid) values (?, 'docs', ?) on conflict do update set head_oid = excluded.head_oid",
    )
    .run(p, head);
  let fired = false;
  const hook: KyselyPlugin = {
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      if (!fired && args.result.rows.some((r) => "head_oid" in r)) {
        fired = true;
        onRead();
      }
      return args.result;
    },
  };
  return db.ingest.withPlugin(hook);
}

const written = (db: TempDb) =>
  (db.owner.prepare("select count(*) as n from source_item").get() as { n: number }).n;

// When two syncs run the same morning, the one that lost to a newer commit does not report failure. Rewinds and forks stop and are shown.
test("finishes without writing when a re-read shows the stored commit is already ahead, and stops on rewinds and forks", async () => {
  await withRepo(async (repo, git) => {
    put(repo, "README.md", "# a\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const older = commitOf(repo, false);
    put(repo, "README.md", "# b\n");
    git("add", "-A");
    git("commit", "-qm", "b");
    const newer = commitOf(repo, false);

    const db = tempDb();
    try {
      const p = project(db);
      git("checkout", "-q", older);
      const raced = headOnly(db, p, newer, () => git("checkout", "-q", newer));
      assert.match(await syncDocs(raced, p, repo, { remote: false }), /stored a newer commit \(.{8}\) first/);

      git("checkout", "-q", older);
      await assert.rejects(
        syncDocs(headOnly(db, p, newer), p, repo, { remote: false }),
        /is not a fast-forward/,
      );

      git("checkout", "-q", "-b", "other");
      put(repo, "README.md", "# c\n");
      git("add", "-A");
      git("commit", "-qm", "c");
      await assert.rejects(
        syncDocs(headOnly(db, p, newer), p, repo, { remote: false }),
        /is not a fast-forward/,
      );
      assert.equal(written(db), 0, "no path wrote documents");
      assert.equal(
        (
          db.owner.prepare("select head_oid from connector where project_id = ?").get(p) as {
            head_oid: string;
          }
        ).head_oid,
        newer,
      );
    } finally {
      await db.done();
    }
  });
});

// **In JS, `.` treats `\r` as a line terminator.** `/^(#{1,3}) +(\S.*)$/` does not match CRLF headings,
// so only documents written on Windows collapse into a single section.
test("splits at headings with CRLF and a BOM", () => {
  const want = ["背景", "決定"];
  const lf = "# 設計\n\n## 背景\n本文\n\n## 決定\nこちら\n";
  assert.deepEqual(
    sections("a.md", lf.replace(/\n/g, "\r\n")).map((s) => s.title),
    want,
    "did not split with CRLF",
  );
  assert.deepEqual(
    sections("a.md", `﻿${lf}`).map((s) => s.title),
    want,
    "the BOM dropped the first heading",
  );
});

// Sections drop heading-only sections, so joining them does not restore the original. The screen shows the body as read.
test("the original text matches the body, including heading-only sections, code fences, and trailing newlines", () => {
  const body = "# 題\n\n## 見出しだけ\n### 子\n\n```sh\n# コメント\n```\n\n末尾\n\n";
  const [doc] = projectDocs(new Map([["docs/a.md", body]]), new Map());
  assert.equal(doc?.body, body);
  assert.notEqual(
    doc?.sections.map((s) => s.text).join("\n"),
    body,
    "if joining sections restored it, the original would not be needed",
  );
});

// **Do not write documents whose body is unchanged.** Rewriting every section in the daily sync bloats index writes (measured: 20,000 rewrites).
test("a document hash depends on its body and is equal for equal bodies", () => {
  const bodies = new Map([["a.md", "# a\n\n本文\n"]]);
  const [x] = projectDocs(bodies, new Map([["a.md", "2026-09-01T00:00:00+09:00"]]));
  const [y] = projectDocs(bodies, new Map([["a.md", "2026-09-01T00:00:00+09:00"]]));
  const [z] = projectDocs(new Map([["a.md", "# a\n\n本文を変えた\n"]]), new Map());
  assert.ok(x && y && z);
  assert.ok(docHash(x).equals(docHash(y)));
  assert.ok(!docHash(x).equals(docHash(z)));
});

test("does not store empty documents", () => {
  assert.deepEqual(projectDocs(new Map([["empty.md", "  \n"]]), new Map()), []);
});

// A withdrawn section left in search returns outdated text as the answer. Deleted documents' originals go too.
test("the sync stores and indexes sections and deletes removed sections and documents", async () => {
  await withRepo(async (repo, git) => {
    const db = tempDb();
    try {
      const p = project(db);
      put(repo, "docs/a.md", "# 設計\n\n## 背景\n柑橘の背景\n\n## 決定\n柑橘で決めた\n");
      put(repo, "docs/b.md", "# 別\n消える文書\n");
      git("add", "-A");
      git("commit", "-qm", "a");
      await syncDocs(db.ingest, p, repo, { remote: false });
      const hit = (q: string) =>
        (
          db.owner
            .prepare(
              "select k.heading from knowledge_fts f join knowledge k on k.id = f.rowid where knowledge_fts match ?",
            )
            .all(q) as { heading: string }[]
        ).map((r) => r.heading);
      assert.deepEqual(
        new Set(hit('"柑橘"')),
        new Set(["docs/a.md > 設計 > 背景", "docs/a.md > 設計 > 決定"]),
      );
      put(repo, "docs/a.md", "# 設計\n\n## 背景\n柑橘の背景\n");
      fs.rmSync(path.join(repo, "docs/b.md"));
      git("add", "-A");
      git("commit", "-qm", "b");
      await syncDocs(db.ingest, p, repo, { remote: false });
      assert.deepEqual(hit('"柑橘"'), ["docs/a.md > 設計 > 背景"]);
      assert.deepEqual(
        (db.owner.prepare("select external_id from source_item").all() as { external_id: string }[]).map(
          (r) => r.external_id,
        ),
        ["docs/a.md"],
      );
      // Unchanged documents are not rewritten (0 on the second sync)
      assert.match(await syncDocs(db.ingest, p, repo, { remote: false }), /0 rewritten/);
    } finally {
      await db.done();
    }
  });
});
