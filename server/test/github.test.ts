import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, type GithubSource, isFiller, speakerOf } from "../src/github.ts";

const user = (login: string, id = login.length) => ({ id, login });

const source: GithubSource = {
  pulls: async () => [
    {
      number: 12,
      title: "取り込みを作り直す",
      body: "gh の 1 経路にする",
      user: user("alice", 1),
      state: "closed",
      merged_at: "2026-09-11T02:00:00Z",
      closed_at: "2026-09-11T02:00:00Z",
      created_at: "2026-09-10T02:00:00Z",
      updated_at: "2026-09-11T02:00:00Z",
      html_url: "https://github.com/acme/app/pull/12",
    },
    {
      number: 13,
      title: "chore(release): 1.2.0",
      body: "リリース",
      user: user("release-bot[bot]", 9),
      state: "closed",
      merged_at: "2026-09-12T02:00:00Z",
      closed_at: "2026-09-12T02:00:00Z",
      created_at: "2026-09-12T01:00:00Z",
      updated_at: "2026-09-12T02:00:00Z",
      html_url: "https://github.com/acme/app/pull/13",
    },
  ],
  issues: async () => [
    // issues エンドポイントは PR も返す
    {
      number: 12,
      title: "取り込みを作り直す",
      body: "x",
      user: user("alice", 1),
      state: "closed",
      closed_at: "",
      created_at: "",
      updated_at: "",
      html_url: "",
      pull_request: {},
    },
    {
      number: 20,
      title: "設計",
      body: "決めたこと",
      user: user("bob", 2),
      state: "open",
      closed_at: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
      html_url: "https://github.com/acme/app/issues/20",
    },
    {
      number: 21,
      title: "週次レポート",
      body: "自動",
      user: user("report[bot]", 8),
      state: "open",
      closed_at: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      html_url: "",
    },
  ],
  reviewComments: async () => [
    {
      id: 30,
      user: user("bob", 2),
      body: "LGTM",
      path: "a.ts",
      line: 3,
      created_at: "2026-09-11T00:00:00Z",
      html_url: "",
      pull_request_url: "https://api.github.com/repos/acme/app/pulls/12",
    },
    {
      id: 31,
      in_reply_to_id: 30,
      user: user("alice", 1),
      body: "再試行で重複しない",
      path: "a.ts",
      line: 3,
      created_at: "2026-09-11T00:10:00Z",
      html_url: "u31",
      pull_request_url: "https://api.github.com/repos/acme/app/pulls/12",
    },
    {
      id: 32,
      user: user("coderabbitai[bot]", 7),
      body: "null を返しうる",
      path: "b.ts",
      line: 9,
      start_line: 7,
      created_at: "2026-09-11T00:20:00Z",
      html_url: "u32",
      pull_request_url: "https://api.github.com/repos/acme/app/pulls/12",
    },
  ],
  issueComments: async () => [
    {
      id: 40,
      user: user("dependabot[bot]", 5),
      body: "Preview: https://x",
      created_at: "2026-09-11T00:00:00Z",
      html_url: "",
      issue_url: "https://api.github.com/repos/acme/app/issues/12",
    },
    {
      id: 41,
      user: user("alice", 1),
      body: "これは DBT 側で",
      created_at: "2026-09-02T00:00:00Z",
      html_url: "u41",
      issue_url: "https://api.github.com/repos/acme/app/issues/20",
    },
  ],
};

test("PR・issue を今の状態に揃え、bot が作った issue と自動通知を落とす", async () => {
  const got = await collect(source);
  assert.deepEqual(
    got.items.map((i) => [i.number, i.kind, i.state]),
    [
      [12, "pull_request", "merged"],
      [13, "pull_request", "merged"],
      [20, "issue", "open"],
    ],
    "リリース PR は残し、bot の定期レポートの issue は入れない",
  );
  const said12 = got.said.get(12) ?? [];
  assert.deepEqual(
    said12.map((s) => [s.externalId, s.speaker, s.replyTo]),
    [
      ["body", "person", null],
      // LGTM は相槌なので落ち、返信は親を持たない発言として残る
      ["r:31", "person", null],
      ["r:32", "assistant", null],
    ],
  );
  assert.deepEqual(said12[2]?.file, { path: "b.ts", line: 9, startLine: 7 });
  assert.equal(
    got.said.get(13)?.[0]?.speaker,
    "bot",
    "リリース PR の本文は bot の発言として持つ（索引しない）",
  );
  assert.deepEqual(
    (got.said.get(20) ?? []).map((s) => s.externalId),
    ["body", "c:41"],
  );
});

// NUL が 1 つあると PostgreSQL の text に入らず、同期の transaction ごと毎日落ちる。
test("GitHub から来た題・handle・URL・path の NUL を落とし、マージ・クローズの時刻を持つ", async () => {
  const nul = "\u0000";
  const got = await collect({
    pulls: async () => [
      {
        number: 1,
        title: `題${nul}`,
        body: "本文",
        user: { id: 1, login: `al${nul}ice` },
        state: "closed",
        merged_at: null,
        closed_at: "2026-09-03T00:00:00Z",
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-05T00:00:00Z",
        html_url: `https://x/${nul}1`,
      },
    ],
    issues: async () => [],
    reviewComments: async () => [
      {
        id: 5,
        user: { id: 2, login: "bob" },
        body: "ここは直す",
        path: `a${nul}.ts`,
        line: 3,
        created_at: "2026-09-02T00:00:00Z",
        html_url: `https://x/${nul}r5`,
        pull_request_url: "https://api/x/pulls/1",
      },
    ],
    issueComments: async () => [],
  });
  const all = JSON.stringify(got.items) + JSON.stringify([...got.said.values()]);
  assert.ok(!all.includes("\\u0000"), all);
  assert.equal(got.items[0]?.closedAt, "2026-09-03T00:00:00Z", "マージせず閉じた PR は閉じた時刻");
  assert.equal(got.items[0]?.state, "closed");
});

// ページ送りの最中に項目が増えると、境界の PR やコメントが 2 ページに現れる。
test("2 ページに現れた同じ PR とコメントを 1 つにする", async () => {
  const pr = {
    number: 5,
    title: "t",
    body: "本文",
    user: { id: 1, login: "alice" },
    state: "open",
    merged_at: null,
    closed_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    html_url: "https://x/5",
  };
  const comment = {
    id: 9,
    user: { id: 2, login: "bob" },
    body: "ここを直す",
    created_at: "2026-09-02T00:00:00Z",
    html_url: "https://x/5#c9",
    issue_url: "https://api/x/issues/5",
  };
  const got = await collect({
    pulls: async () => [pr, pr],
    issues: async () => [],
    reviewComments: async () => [],
    issueComments: async () => [comment, comment],
  });
  assert.deepEqual(
    (got.said.get(5) ?? []).map((s) => s.externalId),
    ["body", "c:9"],
  );
});

test("発言者の種類は名前で決める", () => {
  assert.equal(speakerOf("alice"), "person");
  assert.equal(speakerOf("gemini-code-assist[bot]"), "assistant");
  assert.equal(speakerOf("Copilot"), "assistant");
  assert.equal(speakerOf("dependabot[bot]"), "bot");
});

// 短さだけで落とさない —「これは DBT 側で」は 10 字でも中身がある。
test("相槌だけを落とす", () => {
  assert.equal(isFiller("LGTM!"), true);
  assert.equal(isFiller("了解です。"), true);
  assert.equal(isFiller("![img](https://x)"), true);
  assert.equal(isFiller("これは DBT 側で"), false);
});
