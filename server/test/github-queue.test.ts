import assert from "node:assert/strict";
import test from "node:test";
import { githubSyncMessageSchema } from "../src/github-queue.ts";

test("queue message keeps only the worker contract", () => {
  assert.deepEqual(
    githubSyncMessageSchema.parse({
      installationId: 160761804,
      repositoryId: "1358543932",
      fullName: "iroha924/mitos",
      scopeId: 19,
      private: true,
    }),
    {
      installationId: 160761804,
      repositoryId: "1358543932",
      fullName: "iroha924/mitos",
      scopeId: 19,
    },
  );
});
