import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import OpenAI from "openai";
import { z } from "zod";
import { labelOf, search } from "../../search.ts";
import { db, env } from "../runtime.ts";
import { positiveIds } from "../validation.ts";

const transcribeSchema = z.object({ audio: z.instanceof(File) });
const replySchema = z
  .object({
    heard: z.string().trim().min(1).max(20_000),
    scopeIds: positiveIds.optional(),
  })
  .strict();
const polishSchema = z.object({ text: z.string().trim().min(1).max(50_000) }).strict();

const POLISH = `日本語の音声認識の生の出力を、読める文に直す候補を 3 つ作る。

その出力には次の癖がある。
- 句読点が 1 つも付いていない
- 同音異義語を取り違える（辺→変、触って→座って）
- 数字の桁を外す（三百十→3010）
- 言いよどみ（えー、あの）と言い直しが混ざる

3 つの候補は、直す度合いで分ける。**どれも元の意図を変えない。**
1. label「句読点だけ」… 語を一切変えず、句読点と改行だけを入れる
2. label「整えた」… 言いよどみと言い直しを取り、前後から明らかな誤変換を直す。
   **触るのはそこだけ。**誤変換でない語は 1 つも変えない（「前に」を「以前」に、
   「ダメだった」を「うまくいかなかった」に言い換えない）。言い回しを丁寧にしない
3. label「短く」… 要点だけにする。**数値・固有名詞・条件は 1 つも落とさない。**
   係り受けも変えない（「A が縮んで B が半分」を「A と B が半分」にしない）

changed には、その候補で**書き換えた後の語**だけを、本文に現れるとおりに入れる
（「ペクトル」を「ベクトル」にしたなら "ベクトル"）。句読点の追加は入れない。
語を変えていない候補は空の配列にする。

推測で情報を足さない。元に無いことを書かない。
**つなぎの意味を変えない**（「〜だったので」を「〜だったが」にしない）。
話し手の主張が事実と食い違って見えても、直すのは語であって論理ではない。`;

const REPLY = `会議の相手の発言に対して、その場で返せる案を作る。

まず、それが**答えを求められている発言かどうか**を見る。相槌・世間話・自分の作業の報告なら
asked を null にして replies を空にする。**問われていないのに案を出さない。**

問われているなら、asked にその問いを一文で書く。
replies には返す言葉を 2 つか 3 つ。**渡された記録に書かれていることだけを使う。**
それぞれの sources に、根拠にした記録の番号を入れる（複数可）。

記録に答えが無いなら replies を空にして missing を true にする。
**推測で埋めない。**「たぶん」「〜のはず」で答えると、会議のあとで訂正することになる。

日本語で、会議でそのまま口に出せる長さにする（1 文か 2 文）。`;

const app = new Hono()
  .post("/transcribe", zValidator("form", transcribeSchema), async (c) => {
    const { audio } = c.req.valid("form");
    if (audio.size > 25_000_000) return c.json({ error: "音声が長すぎる（25MB まで）" }, 413);
    if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);

    try {
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const result = await openai.audio.transcriptions.create({
        file: audio,
        model: "whisper-1",
        language: "ja",
      });
      return c.json({ text: result.text.trim() });
    } catch (error) {
      console.error("transcribe:", error instanceof Error ? error.message : String(error));
      return c.json({ error: "文字起こしに失敗した" }, 500);
    }
  })
  .post("/realtime-token", async (c) => {
    if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);
    try {
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const result = await openai.realtime.clientSecrets.create({
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              // This model alone preserved streaming Japanese while finalizing each VAD turn in measurements.
              transcription: { model: "gpt-4o-transcribe", language: "ja" },
              turn_detection: { type: "server_vad" },
              noise_reduction: { type: "near_field" },
            },
          },
        },
      });
      return c.json({ token: result.value, expiresAt: result.expires_at });
    } catch (error) {
      console.error("realtime-token:", error instanceof Error ? error.message : String(error));
      return c.json({ error: "一時鍵を作れなかった" }, 500);
    }
  })
  .post("/reply", zValidator("json", replySchema), async (c) => {
    const { heard, scopeIds } = c.req.valid("json");
    if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);

    try {
      const { rows } = await search(db(), env, { question: heard, scopeIds, limit: 8 });
      const facts = rows.map(
        (row, index) => `[${index + 1}] ${labelOf(row)}${row.text}${row.ex ? ` — ${row.ex}` : ""}`,
      );
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const result = await openai.responses.create({
        model: env.MITOS_CHAT_MODEL ?? "gpt-5.6-terra",
        reasoning: { effort: "low" },
        instructions: REPLY,
        input: `相手の発言:\n${heard}\n\n記録:\n${facts.join("\n") || "(該当なし)"}`,
        text: {
          format: {
            type: "json_schema",
            name: "reply",
            strict: true,
            schema: {
              type: "object",
              properties: {
                asked: { type: ["string", "null"] },
                missing: { type: "boolean" },
                replies: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      sources: { type: "array", items: { type: "integer" } },
                    },
                    required: ["text", "sources"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["asked", "missing", "replies"],
              additionalProperties: false,
            },
          },
        },
      });
      const output = JSON.parse(result.output_text) as {
        asked: string | null;
        missing: boolean;
        replies: { text: string; sources: number[] }[];
      };
      return c.json({
        ...output,
        facts: rows.map((row, index) => ({
          n: index + 1,
          label: labelOf(row),
          text: row.text,
          recordId: row.record_id,
          recordTitle: row.record_title,
        })),
      });
    } catch (error) {
      console.error("reply:", error instanceof Error ? error.message : String(error));
      return c.json({ error: "返信案を作れなかった" }, 500);
    }
  })
  .post("/polish", zValidator("json", polishSchema), async (c) => {
    const { text } = c.req.valid("json");
    if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);

    try {
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const result = await openai.responses.create({
        model: env.MITOS_CHAT_MODEL ?? "gpt-5.6-terra",
        // Lower effort changed correct numbers during repeated measurements.
        reasoning: { effort: "medium" },
        instructions: POLISH,
        input: text,
        text: {
          format: {
            type: "json_schema",
            name: "polish",
            strict: true,
            schema: {
              type: "object",
              properties: {
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      text: { type: "string" },
                      changed: { type: "array", items: { type: "string" } },
                    },
                    required: ["label", "text", "changed"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["options"],
              additionalProperties: false,
            },
          },
        },
      });
      const parsed = JSON.parse(result.output_text) as {
        options: { label: string; text: string; changed: string[] }[];
      };
      return c.json({
        options: parsed.options.filter((option) => option.text.trim() && option.text.trim() !== text),
      });
    } catch (error) {
      console.error("polish:", error instanceof Error ? error.message : String(error));
      return c.json({ error: "整形に失敗した" }, 500);
    }
  });

export default app;
