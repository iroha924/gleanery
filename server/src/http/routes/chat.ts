import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { chat } from "../../chat.ts";
import { reason } from "../../text.ts";
import { db, env } from "../runtime.ts";
import { positiveIds } from "../validation.ts";

const chatSchema = z
  .object({
    question: z.string().trim().min(1).max(20_000),
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(50_000) }).strict())
      .max(8)
      .default([]),
    projects: positiveIds.min(1),
  })
  .strict();

// 会話は保存しない。履歴は画面が持ち、次の質問と一緒に送ってくる。
const app = new Hono().post("/chat", zValidator("json", chatSchema), async (c) => {
  const body = c.req.valid("json");
  const pool = await db();
  return streamSSE(c, async (stream) => {
    const closed = new AbortController();
    stream.onAbort(() => closed.abort());
    const signal = AbortSignal.any([c.req.raw.signal, closed.signal]);
    try {
      for await (const chunk of chat(pool, env, { ...body, signal })) {
        await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
      }
    } catch (error) {
      if (signal.aborted) return;
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: reason(error) }),
      });
    }
    if (!signal.aborted) await stream.writeSSE({ event: "done", data: "{}" });
  });
});

export default app;
