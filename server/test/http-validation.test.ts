import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import chatRoutes from "../src/http/routes/chats.ts";
import githubRoutes from "../src/http/routes/github.ts";
import knowledgeRoutes from "../src/http/routes/knowledge.ts";
import settingsRoutes from "../src/http/routes/settings.ts";
import speechRoutes from "../src/http/routes/speech.ts";

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("JSON の外部入力は handler より前に拒否する", async () => {
  const requests = [
    knowledgeRoutes.request("/search", jsonRequest({ question: "", extra: true })),
    settingsRoutes.request("/groups", jsonRequest({ name: "team", scopeIds: [1] })),
    settingsRoutes.request("/groups", jsonRequest({ name: "team", scopeIds: [1, 1] })),
    settingsRoutes.request("/terms", jsonRequest({ word: "", aliases: [] })),
    speechRoutes.request("/reply", jsonRequest({ heard: "", scopeIds: [1] })),
    speechRoutes.request("/polish", jsonRequest({ text: "" })),
    chatRoutes.request("/chat", jsonRequest({ question: "q", scopeIds: [0] })),
    githubRoutes.request("/github/installations", jsonRequest({ installationId: 0 })),
    githubRoutes.request("/github/sync", jsonRequest({ repositoryId: "-1" })),
  ];

  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 400);
  }
});

test("query・param・multipart の外部入力も拒否する", async () => {
  const form = new FormData();
  form.set("other", "missing audio");
  const requests = [
    knowledgeRoutes.request("/now?scopes=1,no"),
    settingsRoutes.request("/terms/not-a-number", { method: "DELETE" }),
    chatRoutes.request("/chats/not-a-uuid"),
    speechRoutes.request("/transcribe", { method: "POST", body: form }),
  ];

  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 400);
  }
});

test("すべての /api route より先に認証 middleware を登録する", () => {
  const source = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const firstRoute = source.indexOf('app.route("/api"');
  const middleware = [...source.matchAll(/app\.use\("\/api\/\*"/g)].map((match) => match.index);

  assert.equal(middleware.length, 2);
  assert.ok(firstRoute > 0);
  assert.ok(middleware.every((index) => index < firstRoute));
});
