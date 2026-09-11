import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { z } from "zod";
import { chat, type Learn } from "../../chat.ts";
import { scopeFamily } from "../../search.ts";
import { cfg, db, env } from "../runtime.ts";
import { positiveIds, uuidParamSchema } from "../validation.ts";

const chatSchema = z
  .object({
    question: z.string().trim().min(1).max(20_000),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().max(50_000),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    scopeIds: positiveIds.min(1),
    chatId: z.uuid().optional(),
    scopeName: z.string().trim().max(200).optional(),
  })
  .strict();

type ChatRequest = z.infer<typeof chatSchema>;

const TITLE = `会話の題を 1 つ作る。出力は題だけで、前置きも引用符も付けない。

- 日本語で 20 文字以内。
- 何の話だったかが分かる固有の語を必ず入れる（画面名・ファイル名・技術名・決めた事柄）。
- 「〜について」「〜の質問」「記録の確認」のような、中身の無い言い方をしない。
- **名詞を 3 つ以上つなげて 1 語にしない。**助詞を使って読める短い句にする。
- 欧文・数字と和文が隣り合うところに半角空白を入れる。
- 句読点・鉤括弧・絵文字を付けない。`;

async function titleFor(question: string, answer: string, signal: AbortSignal): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const result = await openai.responses.create(
      {
        model: env.MITOS_CHAT_MODEL ?? "gpt-5.6-terra",
        reasoning: { effort: "none" },
        instructions: TITLE,
        input: `質問: ${question}\n\n答え: ${answer.slice(0, 2000)}`,
      },
      { signal },
    );
    const title = result.output_text
      .trim()
      .replace(/^["「『]|["」』]$/g, "")
      .trim();
    return title ? title.slice(0, 60) : null;
  } catch (error) {
    if (signal.aborted) throw error;
    console.error("title:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function saveTurn(
  body: ChatRequest,
  ids: number[],
  answer: string,
  sources: unknown[],
  signal: AbortSignal,
): Promise<string> {
  const client = cfg();
  let chatId = body.chatId;
  if (!chatId) {
    const title = (await titleFor(body.question, answer, signal)) ?? body.question.slice(0, 120);
    signal.throwIfAborted();
    const result = await client.query<{ id: string }>(
      "insert into chat (title, scope_ids, scope_name) values ($1,$2,$3) returning id",
      [title, ids, body.scopeName ?? null],
    );
    chatId = result.rows[0]?.id;
    if (!chatId) throw new Error("会話を作れなかった");
  } else {
    signal.throwIfAborted();
    await client.query("update chat set updated_at = now() where id = $1", [chatId]);
  }
  signal.throwIfAborted();
  await client.query(
    `insert into chat_message (chat_id, role, content, sources) values ($1,'user',$2,'[]'), ($1,'assistant',$3,$4)`,
    [chatId, body.question, answer, JSON.stringify(sources)],
  );
  return chatId;
}

const app = new Hono()
  .get("/chats", async (c) => {
    const result = await db().query(
      `select c.id, c.title, c.scope_name, c.updated_at,
              (select count(*) from chat_message m where m.chat_id = c.id)::int as messages
       from chat c order by c.updated_at desc limit 100`,
    );
    return c.json(result.rows);
  })
  .get("/chats/:id", zValidator("param", uuidParamSchema), async (c) => {
    const client = db();
    const { id } = c.req.valid("param");
    const head = await client.query("select id, title, scope_ids, scope_name from chat where id = $1", [id]);
    if (head.rows.length === 0) return c.json({ error: "その会話は無い" }, 404);
    const messages = await client.query(
      "select role, content, sources, at from chat_message where chat_id = $1 order by at, id",
      [id],
    );
    return c.json({ ...head.rows[0], messages: messages.rows });
  })
  .delete("/chats/:id", zValidator("param", uuidParamSchema), async (c) => {
    try {
      await cfg().query("delete from chat where id = $1", [c.req.valid("param").id]);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  })
  .post("/chat", zValidator("json", chatSchema), async (c) => {
    const body = c.req.valid("json");
    const client = db();
    const ids = body.scopeIds;
    const family = [...new Set((await Promise.all(ids.map((id) => scopeFamily(client, id)))).flat())];

    const groupId = ids.length
      ? (
          await client.query<{ id: number }>(
            "select m.group_id::int as id from group_member m where m.scope_id = any($1) limit 1",
            [ids],
          )
        ).rows[0]?.id
      : undefined;
    // This role can update learned terms but cannot write record, node, or ref.
    const learn: Learn = async (term) => {
      await cfg().query(
        `insert into term (group_id, word, meaning, aliases, asked_why, asked_at)
         values ($1,$2,$3,$4,$5, case when $3::text is null then now() else null end)
         on conflict (coalesce(group_id, 0), word) do update set
           meaning = coalesce(excluded.meaning, term.meaning),
           aliases = case when cardinality(excluded.aliases) > 0 then excluded.aliases else term.aliases end,
           asked_why = coalesce(term.asked_why, excluded.asked_why),
           updated_at = now()`,
        [groupId ?? null, term.word, term.meaning, term.aliases, term.why],
      );
    };

    return streamSSE(c, async (stream) => {
      const disconnected = new AbortController();
      stream.onAbort(() => disconnected.abort());
      const signal = AbortSignal.any([c.req.raw.signal, disconnected.signal]);
      let answer = "";
      let sources: unknown[] = [];
      let completed = false;
      try {
        // Family expands search only; ownership remains the scope selected by the dashboard.
        for await (const chunk of chat(client, env, {
          ...body,
          scopeIds: family,
          ownScope: ids[0] ?? null,
          learn,
          signal,
        })) {
          if (chunk.type === "text") answer += chunk.text;
          else if (chunk.type === "sources") sources = chunk.sources;
          await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
        }
        completed = true;
      } catch (error) {
        if (signal.aborted) return;
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
        });
      }
      if (signal.aborted) return;
      if (completed && answer) {
        try {
          const chatId = await saveTurn(body, ids, answer, sources, signal);
          await stream.writeSSE({ event: "saved", data: JSON.stringify({ chatId }) });
        } catch {
          if (signal.aborted) return;
        }
      }
      await stream.writeSSE({ event: "done", data: "{}" });
    });
  });

export default app;
