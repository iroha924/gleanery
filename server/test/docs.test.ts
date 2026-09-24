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
import { insert, project, type TempDb, tempDb } from "./temp-db.ts";
import { put, withRepo } from "./temp-repo.ts";

// **コードフェンスの中の `#` は見出しではない。**シェルのコメントで節が割れると、
// 説明と、その説明が指すコマンドが別々の断片になる。
test("コードフェンスの中の見出しでは割らない", () => {
  const out = sections(
    "a.md",
    ["## 使い方", "", "```bash", "# これはコメント", "run --now", "```", "", "続き"].join("\n"),
  );
  assert.equal(out.length, 1);
  assert.match(out[0]?.text ?? "", /# これはコメント/);
  assert.match(out[0]?.text ?? "", /続き/);
});

// 4 つのバッククォートの例の中の 3 つのバッククォートで閉じたと読むと、例の中の見出しが節になる。
test("フェンスは同じ文字で同じ長さ以上の、info の無い行でだけ閉じる", () => {
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

test("チルダのフェンスも見る", () => {
  const out = sections("a.md", ["## 節", "~~~", "### 中の見出し", "~~~"].join("\n"));
  assert.equal(out.length, 1);
});

// **同じ題が 1 つのファイルに何度も出る。**key が衝突すると unique (record_id, kind, key) で
// 後勝ちになり、先に書かれた節が黙って消える。
test("同じ題の節でも key が衝突しない", () => {
  const out = sections("a.md", ["## 背景", "いち", "## 判断", "に", "## 背景", "さん"].join("\n"));
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((s) => s.key)).size, 3);
});

// 中身は子が持っている。見出しは子の trail に残るので、落としても失われない。
// 番号を付けた key が別の見出しと同じ文字列になると、1 つの upsert に同じ key が並んで同期ごと落ちる。
test("番号を付けた節の key が、同じ文字列の見出しと重ならない", () => {
  const out = sections("x.md", ["## 背景", "a", "## 背景", "b", "## 背景:2", "c"].join("\n"));
  assert.equal(new Set(out.map((s) => s.key)).size, out.length, out.map((s) => s.key).join(" / "));
});

test("見出しだけの節は置かない", () => {
  const out = sections("a.md", ["## 親", "", "### 子", "中身"].join("\n"));
  assert.deepEqual(
    out.map((s) => s.title),
    ["子"],
  );
  assert.match(out[0]?.trail ?? "", /親 > 子/);
});

// リポジトリが消えた後は原文を取り直せない。切り落とすと永久に失われる。
test("長い節は切り捨てずに続きへ回す", () => {
  const body = Array.from({ length: 60 }, (_, i) => `段落${i}。${"あ".repeat(200)}`).join("\n\n");
  const out = sections("a.md", `## 長い節\n\n${body}`);
  assert.ok(out.length > 1, "分割されていない");
  for (const s of out) assert.ok(s.text.length <= 4000, `${s.text.length} 字の節がある`);
  const joined = out.map((s) => s.text).join("");
  assert.ok(joined.includes("段落0"), "先頭が落ちた");
  assert.ok(joined.includes("段落59"), "末尾が落ちた");
});

// 節だけでは何の話か分からない。見出し（全文検索の索引で 3 倍に重い列）に、どの文書のどの節かを前置する。
test("節の見出しにはどの文書のどの節かが前置される", () => {
  const out = sections("docs/adr/0001-x.md", ["# 決定", "## Context", "背景の説明"].join("\n"));
  const s = out.find((x) => x.title === "Context");
  assert.ok(s);
  assert.equal(s.trail, "docs/adr/0001-x.md > 決定 > Context");
  assert.equal(s.text, "## Context\n背景の説明");
});

// 見出しの無い文書（README の冒頭だけ、CLAUDE.md の `@AGENTS.md` など）も落とさない。
test("見出しの無い本文も 1 件になる", () => {
  const out = sections("CLAUDE.md", "@AGENTS.md\n");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.text, "@AGENTS.md");
  assert.equal(out[0]?.key, "doc:CLAUDE.md#claude.md");
});

// **追跡された symlink を辿ると、リポジトリの外が本文として保存される。**
// commit の tree では symlink は mode 120000 の項目で、ディレクトリの symlink の先はそもそも tree に無い。
// 取り込みは利用者が打つが、出力を読まないことも多い。ここが開くと気付かないまま資格情報が出ていく。
test("commit の tree から読み、symlink の先は本文に入れない", async () => {
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

// 追跡された Markdown が全部「事実を述べた文書」とは限らない。監査の fixture は意図的に壊した見本で、
// 取り込むと架空の規約が本物の手順より上位で返る（実測。iroha924/hir4ta-developer の bloated/CLAUDE.md）。
test("除外した file と directory は取り込まない", async () => {
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

// 作業ツリーを読むと、書きかけの本文が DB に入る。
test("作業ツリーの未 commit の編集は読まず、commit した本文だけを見る", async () => {
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

// 以前の要件定義・設計書の置き場所に残った下書きを検索に出さない。壊れた manifest があっても同期は止めない。
test(".gleanery/ は入れ子も中身も問わず取り込まず、祖先で fast-forward かを見る", async () => {
  await withRepo((repo, git) => {
    put(repo, ".gleanery/project.json", JSON.stringify({ schema: "gleanery/project/1" }));
    put(repo, ".gleanery/changes/a/change.json", "{");
    put(repo, ".gleanery/changes/a/requirements.md", "# 要件\n下書き\n");
    put(repo, "sub/.gleanery/changes/x/design.md", "# 入れ子\n下書き\n");
    put(repo, "docs/gleanery.md", "# 名前が似ているだけ\n本文\n");
    put(repo, "README.md", "# 読んで\n本文\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const first = commitOf(repo, false);
    assert.deepEqual(
      collectDocs(repo, first)
        .docs.map((d) => d.path)
        .sort(),
      ["README.md", "docs/gleanery.md"],
    );
    put(repo, "README.md", "# x\n");
    git("add", "-A");
    git("commit", "-qm", "b");
    const second = commitOf(repo, false);
    assert.equal(isAncestor(repo, first, second), true);
    assert.equal(isAncestor(repo, second, first), false);
    assert.equal(isAncestor(repo, "0".repeat(40), second), false, "この clone に無い commit");
  });
});

test("大文字の拡張子の文書にも最終更新日が付く", async () => {
  await withRepo(async (repo, git) => {
    put(repo, "README.MD", "# 読んで\n本文\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const { docs } = collectDocs(repo, commitOf(repo, false));
    assert.ok(docs.find((d) => d.path === "README.MD")?.at, "README.MD に日付が無い");
  });
});

// 除外は docs の connector に付く。同期は transaction の外でこれを読み、blob を読む前に当てる。
test("除外は docs の connector から読み、kind で file と directory に分かれる", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    assert.deepEqual(
      await excludedOf(db.reader, p),
      { files: [], directories: [] },
      "connector がまだ無くても読める",
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
 * 文書の connector に head だけを持つ DB。onRead は connector を読んだ瞬間に 1 度だけ走る
 * （その間に別の同期が新しい commit を入れた、を再現する）。
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

// 同じ朝に 2 本の同期が走り、新しい commit を先に入れられた側が失敗を報告しない。巻き戻しと分岐は止めて、画面に出す。
test("取り直して前に入れた commit まで進んでいれば何も書かずに終え、巻き戻しと分岐は止める", async () => {
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
      assert.equal(written(db), 0, "どの経路も文書を書いていない");
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

// **JS の `.` は `\r` を行終端として扱う。**CRLF の見出しに `/^(#{1,3}) +(\S.*)$/` が
// 一致せず、Windows で書かれた文書だけが 1 本まるごと 1 つのベクトルに潰れる。
test("CRLF と BOM でも見出しで割れる", () => {
  const want = ["背景", "決定"];
  const lf = "# 設計\n\n## 背景\n本文\n\n## 決定\nこちら\n";
  assert.deepEqual(
    sections("a.md", lf.replace(/\n/g, "\r\n")).map((s) => s.title),
    want,
    "CRLF で割れなかった",
  );
  assert.deepEqual(
    sections("a.md", `﻿${lf}`).map((s) => s.title),
    want,
    "BOM で先頭の見出しが落ちた",
  );
});

// 節は見出しだけの節を落とすので、連結しても元に戻らない。画面が出す原文は読んだ本文をそのまま持つ。
test("原文は見出しだけの節・コードフェンス・末尾の改行を含めて元の本文と一致する", () => {
  const body = "# 題\n\n## 見出しだけ\n### 子\n\n```sh\n# コメント\n```\n\n末尾\n\n";
  const [doc] = projectDocs(new Map([["docs/a.md", body]]), new Map());
  assert.equal(doc?.body, body);
  assert.notEqual(doc?.sections.map((s) => s.text).join("\n"), body, "節の連結で戻るなら原文は要らない");
});

// **本文が同じ文書には書かない。**毎日の同期で全節を書き直すと、索引の書き換えが膨らむ（実測で 2 万回の書き換え）。
test("文書の hash は本文で決まり、同じなら同じ値になる", () => {
  const bodies = new Map([["a.md", "# a\n\n本文\n"]]);
  const [x] = projectDocs(bodies, new Map([["a.md", "2026-09-01T00:00:00+09:00"]]));
  const [y] = projectDocs(bodies, new Map([["a.md", "2026-09-01T00:00:00+09:00"]]));
  const [z] = projectDocs(new Map([["a.md", "# a\n\n本文を変えた\n"]]), new Map());
  assert.ok(x && y && z);
  assert.ok(docHash(x).equals(docHash(y)));
  assert.ok(!docHash(x).equals(docHash(z)));
});

test("中身の無い文書は入れない", () => {
  assert.deepEqual(projectDocs(new Map([["empty.md", "  \n"]]), new Map()), []);
});

// 撤回した節が検索に残ると、古い記述が正解として返る。消えた文書の原文も残さない。
test("同期は節を知識へ入れて索引し、消えた節と文書を消す", async () => {
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
      // 変わっていない文書は書き直さない（2 度目の同期で 0 件）
      assert.match(await syncDocs(db.ingest, p, repo, { remote: false }), /0 rewritten/);
    } finally {
      await db.done();
    }
  });
});
