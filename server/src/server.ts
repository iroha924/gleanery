#!/usr/bin/env node
// 画面と API を 1 つの origin で配る。**手元だけで動き、ログイン機構を持たない。**
//
// 境界は 3 つで、どれも利用者に設定を求めない。
//   1. 127.0.0.1 にだけ bind する（同じ LAN の別マシンから届かない）
//   2. Host が手元の綴りに完全一致する（DNS rebinding を塞ぐ）
//   3. 書き込む要求の Origin を CSRF middleware が見る（他所のページから叩かせない）
//
// CORS middleware は入れない。**許可しないことが、cross-origin の読み取りを止める手段そのもの**なので、
// 足すと preflight に許可を返してしまう。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import chatRoutes from "./http/routes/chat.ts";
import knowledgeRoutes from "./http/routes/knowledge.ts";
import speechRoutes from "./http/routes/speech.ts";

export const DEFAULT_PORT = 8787;

/**
 * 画面のビルド成果物の場所。**cwd から探さない。**どこで起動されても同じものを配る。
 * 配る形（dist/cli.js の隣）と、開発の作業ツリーの両方を見る。
 */
export function dashboardRoot(here = path.dirname(fileURLToPath(import.meta.url))): string | null {
  for (const dir of [path.join(here, "dashboard"), path.join(here, "..", "..", "dashboard", "dist")]) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * port を外から受ける。**0 と空文字と非数値を弾く。**
 * 0 は Node には「空いている番号を選ぶ」の意味だが、Host の allowlist は起動前の番号で作るので、
 * 選ばれた実ポートと食い違って全部 403 になる。
 */
export function parsePort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`MITOS_DASHBOARD_PORT は 1〜65535 の整数にする（受け取った値: ${JSON.stringify(raw)}）`);
  }
  return n;
}

/**
 * Host ヘッダとして受け付ける綴り。
 *
 * `extra` は開発のときだけ渡す。dev では Vite が別の port で画面を出し、`/api` をここへ proxy する。
 * proxy は Host を書き換えないので（書き換えると Origin と食い違って CSRF に弾かれる）、
 * Vite の port も通す必要がある。**配る形では渡さない。**
 */
export const allowedHosts = (port: number, extra: readonly number[] = []): Set<string> =>
  new Set([port, ...extra].flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`]));

export function createApp(port: number, devPorts: readonly number[] = []): Hono {
  const app = new Hono();

  // **静的資産にも掛ける。**画面だけ返して API を塞いでも、返した画面が同じ origin から API を叩く。
  const allowed = allowedHosts(port, devPorts);
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (!host || !allowed.has(host.toLowerCase())) return c.text("Forbidden", 403);
    await next();
  });

  // multipart は CORS の simple request なので、preflight を経ずに他所のページから届く。
  // 文字起こしは音声の長さぶん課金されるので、ここが踏み台になる。
  app.use("/api/*", csrf());

  app.route("/api", knowledgeRoutes);
  app.route("/api", speechRoutes);
  app.route("/api", chatRoutes);

  // **どの route にも当たらなかった /api/* は、ここで 404 に確定させる。**
  // 下の SPA fallback へ落とすと、API の綴り違いと消した endpoint が index.html を 200 で返し、
  // 呼んだ側では JSON の parse error になる。
  app.all("/api/*", (c) => c.json({ error: "そのような API は無い" }, 404));

  const root = dashboardRoot();
  if (root) {
    app.use("*", serveStatic({ root }));
    // serveStatic は見つからないと next() へ抜けるだけで、SPA の fallback を持たない。
    app.get("*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}

/** Vite の dev server の port。`strictPort: true` で固定してあるので、ここも固定で足りる。 */
export const DEV_PORT = 5173;

/**
 * 前面で画面を出す。**塞がっている port へ黙って別の番号を選ばない**（Host の検査と食い違う）。
 *
 * `dev` は開発のときだけ真にする。dev では Vite が画面を出して `/api` をここへ proxy するが、
 * proxy は Host を書き換えない（書き換えると Origin と食い違って CSRF に弾かれる）ので、
 * Vite の port を Host として受け付ける必要がある。**配る形では渡さない。**
 */
export function start(port = parsePort(process.env.MITOS_DASHBOARD_PORT), dev = false): void {
  if (!dev && !dashboardRoot()) {
    throw new Error("画面のビルド成果物が無い。`bun run build` を流してから起動する");
  }
  const app = createApp(port, dev ? [DEV_PORT] : []);
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) =>
    console.log(dev ? `mitos API: http://127.0.0.1:${info.port}` : `mitos: http://127.0.0.1:${info.port}`),
  );
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error(`port ${port} は使われている。空けるか MITOS_DASHBOARD_PORT で別の番号を指定する`);
    process.exit(1);
  });
}

// 直接起動されたときだけ動く（テストと CLI はこの module を import する）。
// **dev は環境変数ではなく argv で受ける。**`VAR=値 command` の形は Windows の cmd で動かない。
if (process.argv[1] && /server\.ts$/.test(process.argv[1])) {
  start(undefined, process.argv.includes("--dev"));
}
