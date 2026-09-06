import assert from "node:assert/strict";
import { test } from "node:test";
import { embedTextFor, type Issue, resultText, threads } from "../src/linear.ts";

const issue = (comments: Issue["comments"]): Issue => ({
  id: "ABC-456",
  title: "本番アラート整備",
  description: "死活監視と業務監視を段階に分けて入れる",
  url: "https://linear.app/example-org/issue/ABC-456",
  status: "In Review",
  statusType: "started",
  project: "システム安定性機能開発",
  labels: [],
  createdBy: "レビュアー A",
  assignee: "Hirata Shunichi",
  createdAt: "2026-07-31T03:20:04.059Z",
  updatedAt: "2026-09-04T02:50:15.275Z",
  comments,
});

const c = (id: string, parentId: string | null, author: string, body: string, at: string) => ({
  id,
  parentId,
  author,
  body,
  at,
});

// **往復で意味が立つ。**「Sentry を分けますか」と「分けない」を別の断片にすると、
// どちらも単体では何も答えない。
test("返信は親のスレッドへまとまる", () => {
  const t = threads(
    issue([
      c("a", null, "平田", "Sentry のプロジェクトを分けますか", "2026-09-04T01:00:00Z"),
      c(
        "b",
        "a",
        "レビュアー A",
        "分けなくていい。alert rule の作り直しが割に合わない",
        "2026-09-04T02:00:00Z",
      ),
      c("z", null, "レビュアー A", "別件です", "2026-09-04T03:00:00Z"),
    ]),
  );
  assert.equal(t.length, 2);
  assert.equal(t[0]?.turns.length, 2);
  assert.equal(t[0]?.turns[0]?.author, "平田");
  assert.equal(t[1]?.turns.length, 1);
});

test("相槌は落とすが、短くても中身があるものは残す", () => {
  const t = threads(
    issue([
      c("a", null, "平田", "ありがとうございます", "2026-09-04T01:00:00Z"),
      c("b", null, "レビュアー A", "DBT 側で", "2026-09-04T02:00:00Z"),
    ]),
  );
  assert.equal(t.length, 1);
  assert.equal(t[0]?.turns[0]?.body, "DBT 側で");
});

// 埋め込む文に issue 番号とプロジェクトを前置しないと、
// 「ABC-456 の件」や「安定性の話」で引けない。
test("埋め込む文には issue 番号とプロジェクトが前置される", () => {
  const i = issue([]);
  const body = embedTextFor(i, null);
  assert.match(body, /ABC-456/);
  assert.match(body, /システム安定性機能開発/);
  assert.match(body, /@レビュアー A/, "本文の書き手が分かること");

  const t = threads(
    issue([c("a", null, "レビュアー A", "DBT 側で実装してください", "2026-09-04T01:00:00Z")]),
  );
  const first = t[0];
  assert.ok(first);
  const comment = embedTextFor(i, first);
  assert.match(comment, /ABC-456/);
  assert.match(comment, /@レビュアー A/);
});

// **大きい結果はファイルへ退避され、content が文字列になる。**
// この形を知らないと本文が空になり、コメントが黙って 0 件で取り込まれる（実測で踏んだ）。
test("退避されたツール結果はファイルから読む", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(os.tmpdir(), `mitos-test-${process.pid}.txt`);
  fs.writeFileSync(file, '{"comments":[{"id":"a"}],"hasNextPage":false}');
  try {
    // 退避先の直後に句点が付く。貪欲に取ると存在しないパスになる。
    const msg = `Error: result (58,461 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${file}.\nFormat: Plain text`;
    assert.equal(resultText(msg), '{"comments":[{"id":"a"}],"hasNextPage":false}');
  } finally {
    fs.unlinkSync(file);
  }
});

test("普通の結果はそのまま読む", () => {
  assert.equal(resultText([{ type: "text", text: '{"ok":1}' }]), '{"ok":1}');
  assert.equal(resultText("そのままの文字列"), "そのままの文字列");
  assert.equal(resultText(undefined), "");
});
