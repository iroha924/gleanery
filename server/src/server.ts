#!/usr/bin/env node

import { clerkMiddleware, getAuth } from "@clerk/hono";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import chatRoutes from "./http/routes/chats.ts";
import githubRoutes from "./http/routes/github.ts";
import githubWebhookRoutes from "./http/routes/github-webhooks.ts";
import knowledgeRoutes from "./http/routes/knowledge.ts";
import settingsRoutes from "./http/routes/settings.ts";
import speechRoutes from "./http/routes/speech.ts";
import { env } from "./http/runtime.ts";

const secretKey = env.CLERK_SECRET_KEY;
const publishableKey = env.CLERK_PUBLISHABLE_KEY;
const allowedUser = env.MITOS_ALLOWED_USER_ID;
if (!secretKey || !publishableKey || !allowedUser) {
  throw new Error(
    "CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY / MITOS_ALLOWED_USER_ID が要る。" +
      "~/.claude/knowledge.env へ入れる（通す user id は `clerk users list --json`）",
  );
}

const configuredOrigins = (env.MITOS_ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
// Clerk skips authorized-party validation when the list is empty, so an empty setting is invalid.
if (configuredOrigins.length === 0) {
  throw new Error("MITOS_ALLOWED_ORIGINS が空。画面を配るオリジンを列挙する（例: https://example.com）");
}
// Preview hosts change per deployment, so the running deployment must authorize its own origins.
const ownOrigins = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
  .filter((host): host is string => Boolean(host))
  .map((host) => `https://${host}`);
const authorizedParties = [...configuredOrigins, ...ownOrigins];

const app = new Hono();

// GitHub signs this public endpoint. It cannot use a Clerk browser session.
app.route("/webhooks", githubWebhookRoutes);

// Every user API route passes Clerk token verification and the single-user authorization boundary first.
app.use("/api/*", clerkMiddleware({ secretKey, publishableKey, authorizedParties }));
app.use("/api/*", async (c, next) => {
  // Mutating routes must not become reachable through Clerk's cookie authentication path.
  if (!c.req.header("authorization")) return c.json({ error: "未認証" }, 401);
  const auth = getAuth(c);
  // Other Clerk token types can carry the same user id; only a dashboard session is accepted.
  if (auth.tokenType !== "session_token" || auth.userId !== allowedUser) {
    return c.json({ error: "未認証" }, 401);
  }
  await next();
});

app.route("/api", knowledgeRoutes);
app.route("/api", settingsRoutes);
app.route("/api", githubRoutes);
app.route("/api", speechRoutes);
app.route("/api", chatRoutes);

// Vercel detects this filename and default export as the Hono service entrypoint.
export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.MITOS_API_PORT ?? 8787);
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) =>
    console.log(`mitos API: http://localhost:${info.port}`),
  );
}
