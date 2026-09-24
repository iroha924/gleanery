import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDecisions, syncDecisions } from "../src/decisions.ts";
import { conversationId } from "../src/knowledge.ts";
import { at, hash, insert, knowledge, project, tempDb } from "./temp-db.ts";

const body = (lines: string) => `## 何を変えたか

本文。

## 採った案と棄却した案

${lines}

## 検証

- 採った: ここは節の外なので読まない
`;

test("extracts the chosen option and the rejected options with reasons, split at commas outside parentheses", () => {
  const got = extractDecisions(
    body(
      "- 採った: `node:sqlite` の 1 ファイル。棄却: PostgreSQL を続ける（利用者に Docker と 4 つの鍵を用意させる）、libSQL（自動記録の列単位の境界が作れない）、DuckDB（cascade と FTS の即時反映が無い）",
    ),
  );
  assert.deepEqual(got.skipped, 0);
  assert.deepEqual(got.decisions, [
    {
      line: "- 採った: `node:sqlite` の 1 ファイル。棄却: PostgreSQL を続ける（利用者に Docker と 4 つの鍵を用意させる）、libSQL（自動記録の列単位の境界が作れない）、DuckDB（cascade と FTS の即時反映が無い）",
      chosen: "`node:sqlite` の 1 ファイル",
      rejected: [
        { text: "PostgreSQL を続ける", reason: "利用者に Docker と 4 つの鍵を用意させる" },
        { text: "libSQL", reason: "自動記録の列単位の境界が作れない" },
        { text: "DuckDB", reason: "cascade と FTS の即時反映が無い" },
      ],
    },
  ]);
});

test("does not split at commas inside reasons or nested parentheses", () => {
  const got = extractDecisions(
    body(
      "- 採った: 返し方は JSON の文字列。棄却: 2 つの見出しで分けた枠付きテキスト（開発用 42 問の 3 回平均で top1 83.3% 対 85.7%、recall@5 92.8% 対 93.7%）、生成 API を持つ（鍵が要る（サブスクは不可）、依存が増える）",
    ),
  );
  assert.deepEqual(got.decisions[0]?.rejected, [
    {
      text: "2 つの見出しで分けた枠付きテキスト",
      reason: "開発用 42 問の 3 回平均で top1 83.3% 対 85.7%、recall@5 92.8% 対 93.7%",
    },
    { text: "生成 API を持つ", reason: "鍵が要る（サブスクは不可）、依存が増える" },
  ]);
});

test("a line without rejections has only the chosen option, a rejection without a reason gets null, and full-width colons work", () => {
  const got = extractDecisions(body("- 採った：単独の案\n- 採った: A。棄却: B"));
  assert.deepEqual(
    got.decisions.map((d) => [d.chosen, d.rejected]),
    [
      ["単独の案", []],
      ["A", [{ text: "B", reason: null }]],
    ],
  );
});

test("skips and counts bullets that do not fit the format, and ignores code blocks and comments", () => {
  const got = extractDecisions(
    body(
      [
        "<!--",
        "- 採った: テンプレートの例。棄却: 例（例）",
        "-->",
        "- 範囲の解決を起動側へ寄せた。棄却: 3 体へ足す案（原因が残る）",
        "```",
        "- 採った: コードの中。棄却: 例（例）",
        "```",
        "- 採った: 残る案。棄却: 捨てた案（理由）",
        "- 採った: 。棄却: 採った案が空（理由）",
        "段落の文は数えない",
      ].join("\n"),
    ),
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["残る案"],
  );
  assert.equal(got.skipped, 2);
});

test("extracts nothing from a body without the section", () => {
  assert.deepEqual(extractDecisions("## 何を変えたか\n\n- 採った: 節の外。棄却: 例（例）\n"), {
    decisions: [],
    skipped: 0,
  });
});

// ---- Write to the database (bodies of merged PRs by the owner only) ----

const SECTION = (lines: string) => `本文\n\n## 採った案と棄却した案\n\n${lines}\n`;
const LINE_A = "- 採った: 実 DB。棄却: 偽の db（権限が見えない）、文字列の照合（実行されない SQL が通る）";
const LINE_B = "- 採った: begin immediate。棄却: 既定の begin（busy_timeout を待たずに落ちる）";

function setup() {
  const db = tempDb();
  const p = project(db);
  const connector = insert(db, "connector", { project_id: p, provider: "github" });
  const pr = (n: number, state: "merged" | "open") => {
    const source = insert(db, "source_item", {
      connector_id: connector,
      external_id: String(n),
      kind: "pull_request",
      title: `PR ${n}`,
      state,
      url: `https://github.com/o/r/pull/${n}`,
      closed_at: state === "merged" ? at("2026-09-20T01:00:00Z") : null,
      content_hash: hash(),
    });
    const conversation = conversationId(p, "github", `o/r#${n}`);
    insert(db, "conversation", {
      id: conversation,
      project_id: p,
      source_item_id: source,
      origin: "github",
      external_id: `o/r#${n}`,
      started_at: at("2026-09-19T00:00:00Z"),
    });
    return { number: n, source, conversation };
  };
  const mine = pr(117, "merged");
  const theirs = pr(118, "merged");
  const open = pr(119, "open");
  const input = (body: string, over: Partial<Record<number, { authorId: number }>> = {}) =>
    [
      { ...mine, authorId: 1 },
      { ...theirs, authorId: 2 },
      { ...open, authorId: 1 },
    ].map((x) => ({
      number: x.number,
      merged: x.number !== 119,
      mergedAt: x.number !== 119 ? "2026-09-20T01:00:00Z" : null,
      url: `https://github.com/o/r/pull/${x.number}`,
      sourceItemId: x.source,
      conversationId: x.conversation,
      body,
      authorId: over[x.number]?.authorId ?? x.authorId,
    }));
  const rows = () =>
    db.owner
      .prepare(
        "select id, source_key, kind, status, body, reason, heading, decision_id, source_item_id from knowledge order by id",
      )
      .all() as {
      id: number;
      source_key: string;
      kind: string;
      status: string;
      body: string;
      reason: string | null;
      heading: string;
      decision_id: number | null;
      source_item_id: number;
    }[];
  const self = () => {
    const person = insert(db, "person", { display_name: "私", is_self: 1 });
    insert(db, "person_identity", { person_id: person, provider: "github", external_id: "1", handle: "me" });
    return person;
  };
  return { db, p, mine, rows, input, self };
}

test("creates no decisions and says so when the owner is not linked", async () => {
  const { db, p, rows, input } = setup();
  try {
    const got = await syncDecisions(db.ingest, p, "o/r", input(SECTION(LINE_A)));
    assert.equal(got.unlinked, true);
    assert.equal(rows().length, 0);
  } finally {
    await db.done();
  }
});

test("stores decisions and options only from bodies of merged PRs by the owner", async () => {
  const { db, p, mine, rows, input, self } = setup();
  try {
    self();
    const got = await syncDecisions(db.ingest, p, "o/r", input(SECTION(`${LINE_A}\n- 自由な文`)));
    assert.deepEqual([got.unlinked, got.written, got.skipped], [false, 4, 1]);
    const r = rows();
    assert.deepEqual(
      r.map((x) => [x.kind, x.status, x.body, x.reason]),
      [
        ["decision", "accepted", "実 DB", null],
        ["option", "chosen", "実 DB", null],
        ["option", "rejected", "偽の db", "権限が見えない"],
        ["option", "rejected", "文字列の照合", "実行されない SQL が通る"],
      ],
    );
    assert.ok(r.every((x) => x.source_item_id === mine.source));
    assert.ok(r.slice(1).every((x) => x.decision_id === r[0]?.id));
    assert.match(r[0]?.source_key ?? "", /^github:o\/r\/pull\/117#[0-9a-f]{12}-1$/);
    assert.equal(r[0]?.heading, "Decisions in PR #117 (2026-09-20)");
    // Lines in a body with no decisions (free text in old PRs) are not counted (so the same count is not reported every time)
    const free = await syncDecisions(db.ingest, p, "o/r", input(SECTION("- 自由な文\n- もう 1 つ")));
    assert.equal(free.skipped, 0);
  } finally {
    await db.done();
  }
});

test("does not rewrite an unchanged body, and replaces old rows when a line is edited", async () => {
  const { db, p, rows, input, self } = setup();
  try {
    self();
    await syncDecisions(db.ingest, p, "o/r", input(SECTION(`${LINE_A}\n${LINE_B}`)));
    const before = rows();
    const again = await syncDecisions(db.ingest, p, "o/r", input(SECTION(`${LINE_A}\n${LINE_B}`)));
    assert.equal(again.written, 0);
    assert.deepEqual(rows(), before);

    await syncDecisions(
      db.ingest,
      p,
      "o/r",
      input(SECTION(`${LINE_A}\n- 採った: 束ねて書く。棄却: 1 行ずつ（遅い）`)),
    );
    const after = rows();
    assert.ok(after.some((x) => x.body === "束ねて書く"));
    assert.ok(!after.some((x) => x.body === "begin immediate"));
    // Kept rows keep their ids (k:<id> references do not break)
    assert.equal(after.find((x) => x.body === "実 DB" && x.kind === "decision")?.id, before[0]?.id);
  } finally {
    await db.done();
  }
});

test("a decision overturned by trace stays overturned after a resync and an extraction rule version bump", async () => {
  const { db, p, rows, input, self } = setup();
  try {
    self();
    await syncDecisions(db.ingest, p, "o/r", input(SECTION(LINE_A)));
    const decision = rows()[0];
    const later = knowledge(db, p, {
      source_key: "later",
      kind: "decision",
      status: "accepted",
      body: "覆した",
    });
    db.owner
      .prepare("update knowledge set status = 'superseded', superseded_by_id = ? where id = ?")
      .run(later, decision?.id ?? 0);
    db.owner
      .prepare("update knowledge set status = 'was_chosen' where kind = 'option' and status = 'chosen'")
      .run();
    // As with a rule version bump, change the content hash and sync again
    db.owner.prepare("update knowledge set content_hash = ? where source_key like 'github:%'").run(hash(7));
    await syncDecisions(db.ingest, p, "o/r", input(SECTION(LINE_A)));
    const r = rows().filter((x) => x.source_key.startsWith("github:"));
    assert.equal(r.find((x) => x.kind === "decision")?.status, "superseded");
    assert.equal(r.find((x) => x.body === "実 DB" && x.kind === "option")?.status, "was_chosen");
  } finally {
    await db.done();
  }
});

test("unlinking the owner removes rows built from their bodies on the next sync", async () => {
  const { db, p, rows, input, self } = setup();
  try {
    self();
    await syncDecisions(db.ingest, p, "o/r", input(SECTION(LINE_A)));
    assert.ok(rows().length > 0);
    db.owner.prepare("update person_identity set person_id = null where external_id = '1'").run();
    const got = await syncDecisions(db.ingest, p, "o/r", input(SECTION(LINE_A)));
    assert.equal(got.unlinked, true);
    assert.equal(rows().length, 0);
  } finally {
    await db.done();
  }
});

test("deleting a PR removes the rows built from it", async () => {
  const { db, p, mine, rows, input, self } = setup();
  try {
    self();
    await syncDecisions(db.ingest, p, "o/r", input(SECTION(LINE_A)));
    db.owner.prepare("delete from source_item where id = ?").run(mine.source);
    assert.equal(rows().length, 0);
  } finally {
    await db.done();
  }
});

test("a section heading inside a code block, or a fence of a different kind, neither starts nor ends the section", () => {
  const got = extractDecisions(
    [
      "```md",
      "## 採った案と棄却した案",
      "- 採った: 例の中。棄却: 例（例）",
      "```",
      "## 採った案と棄却した案",
      "```",
      "~~~",
      "- 採った: まだコードの中。棄却: 例（例）",
      "```",
      "- 採った: 本物。棄却: 偽物（理由）",
      "<!-- 閉じていないコメント",
      "- 採った: コメントの中。棄却: 例（例）",
    ].join("\n"),
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["本物"],
  );
});

test("splits at the rejection marker only after a full stop, and skips incomplete or unclosed lines entirely", () => {
  const got = extractDecisions(
    body(
      [
        "- 採った: 記号「棄却:」を許す。棄却: B（理由）",
        "- 採った: A。棄却: B（理由）、",
        "- 採った: A。棄却: B（未閉",
        "- 採った: A 棄却: B（理由）",
        "- 採った: A。棄却: B (半角の理由)",
      ].join("\n"),
    ),
  );
  assert.deepEqual(
    got.decisions.map((d) => [d.chosen, d.rejected]),
    [
      ["記号「棄却:」を許す", [{ text: "B", reason: "理由" }]],
      ["A", [{ text: "B", reason: "半角の理由" }]],
    ],
  );
  assert.equal(got.skipped, 3);
});

test("a fence closes only on a line with nothing but spaces after the marker, and comment markers in code do not cut the body", () => {
  const got = extractDecisions(
    [
      "## 採った案と棄却した案",
      "```",
      "```ts",
      "- 採った: コードの中。棄却: 例（例）",
      "const s = '<!--';",
      "```",
      "- 採った: 本物。棄却: 偽物（理由）",
    ].join("\n"),
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["本物"],
  );
});

test("skips a chosen option with unclosed parentheses, and does not split at the rejection marker inside parentheses", () => {
  const got = extractDecisions(
    body(
      ["- 採った: A（未閉。棄却: B（理由）", "- 採った: A（説明。棄却: 引用）。棄却: B（理由）"].join("\n"),
    ),
  );
  assert.deepEqual(
    got.decisions.map((d) => [d.chosen, d.rejected]),
    [["A（説明。棄却: 引用）", [{ text: "B", reason: "理由" }]]],
  );
  assert.equal(got.skipped, 1);
});

test("CommonMark edges: a fence indented 4 spaces does not close, parentheses in inline code do not count, and mismatched brackets do not balance", () => {
  const got = extractDecisions(
    body(
      [
        "```",
        "    ```",
        "- 採った: コードの中。棄却: 例（例）",
        "```",
        "- 採った: `parse(` を使う。棄却: 自前（数え落とす）",
        "- 採った: A（説明)。棄却: B（理由）",
      ].join("\n"),
    ),
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["`parse(` を使う"],
  );
  assert.equal(got.skipped, 1);
});

test("accepts only top-level chosen-option bullets in the section, and skips and counts tasks, numbered items, other markers, and nested items", () => {
  const got = extractDecisions(
    body(
      [
        "- [ ] 採った: 未チェック。棄却: B（理由）",
        "1. 採った: 番号。棄却: B（理由）",
        "",
        "+ 採った: 他の記号。棄却: B（理由）",
        "",
        "- 親",
        "  - 採った: 入れ子。棄却: B（理由）",
        "- 採った: 受け付ける。棄却: B（理由）",
      ].join("\n"),
    ),
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["受け付ける"],
  );
  assert.equal(got.skipped, 5);
});

test("### inside the section does not end it, H2 does", () => {
  const got = extractDecisions(
    "## 採った案と棄却した案\n\n- 採った: A。棄却: B（理由）\n\n### 注記\n\n- 採った: C。棄却: D（理由）\n\n## 検証\n\n- 採った: 外。棄却: E（理由）\n",
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["A", "C"],
  );
});

test("skips items containing HTML, and reads escapes and backticks of different lengths the way marked does", () => {
  const got = extractDecisions(
    body(
      [
        "- 採った: A <!-- 。棄却: 偽（理由） -->。棄却: B（理由）",
        "- 採った: \\`A（\\`。棄却: B（理由）",
        "- 採った: ``a（`` を使う。棄却: B（理由）",
      ].join("\n"),
    ),
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["``a（`` を使う"],
  );
  assert.equal(got.skipped, 2);
});

test("escapes inside emphasis do not count as parentheses, and nested lists inside a quote are counted", () => {
  const got = extractDecisions(
    body(["- 採った: *A \\( B*。棄却: C（理由）", "- 親", "  > - 採った: 子。棄却: D（理由）"].join("\n")),
  );
  assert.deepEqual(
    got.decisions.map((d) => d.chosen),
    ["*A \\( B*"],
  );
  assert.equal(got.skipped, 2);
});
