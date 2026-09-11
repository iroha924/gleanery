import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, type GithubSource } from "../src/github.ts";

test("CLI以外の取得元でも既存のGitHub正規化を共用する", async () => {
  const source: GithubSource = {
    pulls: async () => [
      {
        number: 12,
        title: "Queue worker",
        body: "GitHub Appから同期する",
        user: { login: "alice" },
        state: "closed",
        merged_at: "2026-09-11T02:00:00Z",
        created_at: "2026-09-10T02:00:00Z",
        html_url: "https://github.com/acme/app/pull/12",
        head: { ref: "github-app" },
      },
    ],
    issues: async () => [
      {
        number: 12,
        title: "Queue worker",
        body: "PRはissuesにも現れる",
        user: { login: "alice" },
        state: "closed",
        created_at: "2026-09-10T02:00:00Z",
        html_url: "https://github.com/acme/app/pull/12",
        pull_request: {},
      },
    ],
    reviewComments: async () => [
      {
        id: 30,
        user: { login: "bob" },
        body: "再試行しても重複しないようにする",
        path: "server/src/worker.ts",
        line: 20,
        created_at: "2026-09-11T01:00:00Z",
        html_url: "https://github.com/acme/app/pull/12#discussion_r30",
        pull_request_url: "https://api.github.com/repos/acme/app/pulls/12",
      },
      {
        id: 31,
        in_reply_to_id: 30,
        user: { login: "alice" },
        body: "content hashで吸収する",
        path: "server/src/worker.ts",
        line: 20,
        created_at: "2026-09-11T01:30:00Z",
        html_url: "https://github.com/acme/app/pull/12#discussion_r31",
        pull_request_url: "https://api.github.com/repos/acme/app/pulls/12",
      },
    ],
    issueComments: async () => [],
  };

  const result = await collect("acme/app", source);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0]?.state, "merged");
  assert.equal(result.threads.length, 1);
  assert.deepEqual(
    result.threads[0]?.turns.map((turn) => turn.author),
    ["bob", "alice"],
  );
});
