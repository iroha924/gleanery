#!/usr/bin/env node

import fs from "node:fs";

const failures = [];
const read = (file) => fs.readFileSync(file, "utf8");
const vercel = JSON.parse(read("vercel.json"));
const worker = vercel.services?.github_worker;
const trigger = worker?.functions?.["src/github-worker.ts"]?.experimentalTriggers?.[0];

if (worker?.entrypoint !== "src/github-worker.ts")
  failures.push("GitHub workerのentrypointが固定されていない");
if (trigger?.type !== "queue/v2beta" || trigger?.topic !== "github-sync") {
  failures.push("GitHub workerがgithub-sync Queueだけを入口にしていない");
}
if (vercel.rewrites?.some((rewrite) => rewrite.destination?.service === "github_worker")) {
  failures.push("private GitHub workerを公開rewriteへ繋いでいる");
}

const server = read("server/src/server.ts");
const webhook = server.indexOf('app.route("/webhooks", githubWebhookRoutes)');
const clerk = server.indexOf('app.use("/api/*", clerkMiddleware');
if (webhook < 0 || clerk < 0 || webhook > clerk) {
  failures.push("署名付きwebhookをClerkのuser APIと別の入口に置いていない");
}

const workerSource = read("server/src/github-worker.ts");
if (!workerSource.includes('pool(env, { as: "github" })')) {
  failures.push("GitHub workerが専用DB roleを使っていない");
}
if (workerSource.includes("KNOWLEDGE_DB_URL")) failures.push("GitHub workerが接続文字列を直接選んでいる");

const database = read("server/src/db.ts");
if (!database.includes("KNOWLEDGE_DB_URL_GITHUB") || !database.includes('as !== "admin" && !named')) {
  failures.push("GitHub用DB鍵が管理鍵へfallbackしうる");
}

const dashboard = fs
  .readdirSync("dashboard/src", { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .map((file) => read(`dashboard/src/${file}`))
  .join("\n");
for (const secret of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET", "KNOWLEDGE_DB_URL_GITHUB"]) {
  if (dashboard.includes(secret)) failures.push(`${secret}をbrowser bundleから参照している`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("GitHub境界: 署名webhook / private Queue worker / 専用DB role");
