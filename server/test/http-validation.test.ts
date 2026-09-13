import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import chatRoutes from "../src/http/routes/chat.ts";
import knowledgeRoutes from "../src/http/routes/knowledge.ts";
import speechRoutes from "../src/http/routes/speech.ts";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// 不正な入力が DB や外部 API へ届く前に止まる（handler は DB を引くので、届けば 500 か接続待ちになる）。
test("JSON の外部入力は handler より前に拒否する", async () => {
  const responses = await Promise.all([
    chatRoutes.request("/chat", json({ question: "q", projects: [0] })),
    chatRoutes.request("/chat", json({ question: "q", projects: [] })),
    chatRoutes.request("/chat", json({ question: "", projects: [1] })),
    chatRoutes.request("/chat", json({ question: "q", projects: [1], extra: true })),
    speechRoutes.request("/reply", json({ heard: "", projects: [1] })),
    speechRoutes.request("/reply", json({ heard: "x", projects: [] })),
    speechRoutes.request("/polish", json({ text: "" })),
  ]);
  for (const r of responses) assert.equal(r.status, 400);
});

test("query・param・multipart の外部入力も拒否する", async () => {
  const form = new FormData();
  form.set("other", "missing audio");
  const responses = await Promise.all([
    knowledgeRoutes.request("/sessions?project=no"),
    knowledgeRoutes.request("/sessions?page=0"),
    knowledgeRoutes.request("/sessions?pageSize=101"),
    knowledgeRoutes.request("/sessions/not-a-uuid"),
    // 参照は 4 種の接頭辞と id だけ。パスや SQL を渡せる形にしない。
    knowledgeRoutes.request("/read?ref=../etc/passwd"),
    knowledgeRoutes.request("/read?ref=k:1;drop"),
    speechRoutes.request("/transcribe", { method: "POST", body: form }),
  ]);
  for (const r of responses) assert.equal(r.status, 400);
});

test("すべての /api route より先に認証 middleware を登録し、公開の例外を置かない", () => {
  const source = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const firstRoute = source.indexOf('app.route("/api"');
  const middleware = [...source.matchAll(/app\.use\("\/api\/\*"/g)].map((m) => m.index);
  assert.equal(middleware.length, 2);
  assert.ok(firstRoute > 0 && middleware.every((i) => i < firstRoute));
  assert.deepEqual(
    [...source.matchAll(/app\.route\("([^"]+)"/g)].map((m) => m[1]),
    ["/api", "/api", "/api"],
  );
});
