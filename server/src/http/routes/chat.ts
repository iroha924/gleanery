import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { z } from "zod";
import { chat } from "../../chat.ts";
import { framed } from "../../search.ts";
import { reason } from "../../text.ts";
import { cleanTitle, TITLE_INSTRUCTIONS, TITLE_MODEL } from "../../titles.ts";
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

// 題を付ける入口。**履歴そのものは画面（IndexedDB）が持つ**ので、ここは文字列を返すだけで DB を触らない。
const titleSchema = z.object({ question: z.string().trim().min(1).max(20_000) }).strict();

// 答えは保存しない。直近の往復は画面が持ち、次の質問と一緒に送ってくる。
const app = new Hono().post("/chat", zValidator("json", chatSchema), async (c) => {
  const body = c.req.valid("json");
  return streamSSE(c, async (stream) => {
    const closed = new AbortController();
    stream.onAbort(() => closed.abort());
    const signal = AbortSignal.any([c.req.raw.signal, closed.signal]);
    try {
      for await (const chunk of chat(db, env, { ...body, signal })) {
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

const withTitle = app.post("/chat/title", zValidator("json", titleSchema), async (c) => {
  const { question } = c.req.valid("json");
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);
  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const result = await openai.responses.create({
      model: TITLE_MODEL,
      reasoning: { effort: "low" },
      instructions: TITLE_INSTRUCTIONS,
      input: framed(question),
    });
    const title = cleanTitle(result.output_text);
    if (!title) return c.json({ error: "題を作れなかった" }, 502);
    return c.json({ title });
  } catch (error) {
    console.error("chat/title:", reason(error));
    return c.json({ error: "題を作れなかった" }, 502);
  }
});

export default withTitle;
