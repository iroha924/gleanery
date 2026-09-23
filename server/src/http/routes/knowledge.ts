import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { REF, read } from "../../search.ts";
import { listSessions, projects, searchSessions, sessionDetail } from "../../sessions.ts";
import { db, env } from "../runtime.ts";
import { positiveId, positiveIds, uuidParamSchema } from "../validation.ts";

const conversationsQuery = z.object({
  project: positiveId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

// 判断（knowledge）・通ってはいけない道（avoid）・持ち主の発言（said）で引き、どの session の記録かでまとめる。
const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  mode: z.enum(["knowledge", "avoid", "said"]).default("knowledge"),
  project: positiveId.optional(),
});

// どの作業場所について読むかは画面が持つ（チャットで選んだ作業場所）。その外の参照は「無い」と返す。
const refQuery = z.object({
  ref: z.string().regex(REF),
  projects: z
    .string()
    .transform((v) => v.split(",").map(Number))
    .pipe(positiveIds.min(1)),
});

const app = new Hono()
  .get("/projects", async (c) => c.json(await projects(db)))
  // coding session の一覧。GitHub の会話は PR・issue の単位なので、ここには出さない。
  .get("/sessions", zValidator("query", conversationsQuery), async (c) =>
    c.json(await listSessions(db, c.req.valid("query"))),
  )
  // GitHub の会話と文書は session ではないので外す（PR・issue は検索ではなくチャットの list_items で引く）。
  .get("/sessions/search", zValidator("query", searchQuery), async (c) =>
    c.json(await searchSessions(db, env, c.req.valid("query"))),
  )
  .get("/sessions/:id", zValidator("param", uuidParamSchema), async (c) => {
    const found = await sessionDetail(db, c.req.valid("param").id);
    return found ? c.json(found) : c.json({ error: "その session は無い" }, 404);
  })
  // チャットの根拠を開いたときの全文。MCP の read と同じ関数を通す。
  .get("/read", zValidator("query", refQuery), async (c) => {
    const { ref, projects } = c.req.valid("query");
    return c.json({ text: await read(db, [ref], 16 * 1024, { projects }) });
  });

export default app;
