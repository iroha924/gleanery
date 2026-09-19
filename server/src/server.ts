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

/** Host ヘッダとして受け付ける綴り。port ごとに決まる。 */
export const allowedHosts = (port: number): Set<string> =>
  new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

export function createApp(port: number): Hono {
  const app = new Hono();

  // **静的資産にも掛ける。**画面だけ返して API を塞いでも、返した画面が同じ origin から API を叩く。
  const allowed = allowedHosts(port);
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

  const root = dashboardRoot();
  if (root) {
    app.use("*", serveStatic({ root }));
    // serveStatic は見つからないと next() へ抜けるだけで、SPA の fallback を持たない。
    // /api/* は上で先に処理されるので、ここへ来るのは画面の path だけ。
    app.get("*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}

/** 前面で画面を出す。**塞がっている port へ黙って別の番号を選ばない**（Host の検査と食い違う）。 */
export function start(port = Number(process.env.MITOS_DASHBOARD_PORT ?? DEFAULT_PORT)): void {
  if (!dashboardRoot()) {
    throw new Error("画面のビルド成果物が無い。`bun run build` を流してから起動する");
  }
  const server = serve({ fetch: createApp(port).fetch, port, hostname: "127.0.0.1" }, (info) =>
    console.log(`mitos: http://127.0.0.1:${info.port}`),
  );
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error(`port ${port} は使われている。空けるか MITOS_DASHBOARD_PORT で別の番号を指定する`);
    process.exit(1);
  });
}

// 直接起動されたときだけ動く（テストと CLI はこの module を import する）。
if (process.argv[1] && /server\.ts$/.test(process.argv[1])) start();
