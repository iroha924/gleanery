// trace の記録を知識（knowledge）と作業の現在地（work_item）へ入れる。
//
// **会話は入れない。**会話は自動記録（capture.ts）が逐語で持っている。trace が選ぶのは、
// 次の判断を誤らないために残す判断だけ — 決定と棄却した案、制約、やらないこと、行き止まり、分かったこと、
// 意図して残した負債、検証、問い。そして「続きをやる」ときに読む作業の現在地。
//
// 形の検査はここに 1 つだけ置き、`mitos trace check` と `mitos trace save` が同じ関数を通る。

import type pg from "pg";
import { z } from "zod";
import { EMBED_MODEL, type Env, inTransaction } from "./db.ts";
import { fillKnowledge } from "./embeddings.ts";
import { conversationId, knowledgeText } from "./knowledge.ts";
import { sha256, tsvector } from "./text.ts";

const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const key = z.string().regex(KEY, "小文字英数字と . _ - だけの意味のある語にする");
/** 別の session の決定を指すときは `<host>:<session id>#<key>`。`mitos trace context` がこの形で出す。 */
const ref = z.string().regex(/^([a-z-]+:[^#\s]+#)?[a-z0-9][a-z0-9._-]*$/, "key か <host>:<session id>#<key>");
const at = z.iso.datetime({
  offset: true,
  message: "ISO 8601 のオフセット付きで書く（例 2026-09-13T10:00:00+09:00）",
});
const text = z.string().trim().min(1);
const file = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((p) => !p.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(p), "作業場所の根からの相対パスにする"),
    role: z.enum(["applies_to", "evidence"]),
    line: z.number().int().positive().optional(),
  })
  .strict();

const common = {
  key,
  at,
  text,
  confidence: z.enum(["fact", "inference", "opinion"]).optional(),
  /** ファイル以外の根拠。`commit:<sha>`、`url:<URL>`、`cmd:<コマンド>`、`issue:#<番号>` のように種類を前置する */
  refs: z.array(text).default([]),
  files: z.array(file).default([]),
};

const decision = z
  .object({
    ...common,
    kind: z.literal("decision"),
    status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
    /** そのとき働いていた力。なぜこの決定が要ったか */
    context: text,
    options: z.array(z.object({ text, chosen: z.boolean(), why: text.optional() }).strict()).min(1),
    /** この決定が守られていることをどう確かめるか */
    confirmation: text.optional(),
    /** 承知で引き受けた不利 */
    downsides: z.array(text).default([]),
    /** この決定が覆す決定 */
    supersedes: ref.optional(),
  })
  .strict();

const verification = z
  .object({
    ...common,
    kind: z.literal("verification"),
    status: z.enum(["passed", "failed", "not_run"]),
    command: text.optional(),
    /** 実行しなかった理由（not_run のとき） */
    reason: text.optional(),
    /** どの決定を確かめたか */
    verifies: ref.optional(),
  })
  .strict();

const question = z
  .object({ ...common, kind: z.literal("question"), status: z.enum(["open", "blocking", "resolved"]) })
  .strict();
const boundary = z
  .object({
    ...common,
    kind: z.enum(["constraint", "non_goal", "debt"]),
    status: z.enum(["active", "retired"]),
  })
  .strict();
const event = z.object({ ...common, kind: z.enum(["dead_end", "finding"]) }).strict();

const item = z.discriminatedUnion("kind", [decision, verification, question, boundary, event]);
export type TraceItem = z.infer<typeof item>;

export const traceSchema = z
  .object({
    schema: z.literal("trace/1"),
    session: z
      .object({
        host: z.enum(["claude-code", "codex"]),
        id: text,
        branch: text.optional(),
        startedAt: at.optional(),
      })
      .strict(),
    work: z
      .object({
        key,
        title: text,
        /** 達成を測れる形で */
        goal: text,
        current: text,
        /** 次にやること。人が手を動かすものは先頭に「人:」を付ける */
        next: z.array(text).default([]),
        status: z.enum(["active", "blocked", "paused", "done", "abandoned"]),
      })
      .strict()
      .optional(),
    items: z.array(item),
  })
  .strict()
  .superRefine((t, ctx) => {
    const keys = new Set<string>();
    const decisions = new Set(t.items.filter((i) => i.kind === "decision").map((i) => i.key));
    t.items.forEach((i, n) => {
      const at = (m: string, ...p: (string | number)[]) =>
        ctx.addIssue({ code: "custom", message: m, path: ["items", n, ...p] });
      if (keys.has(i.key)) at(`key ${i.key} が重複している`, "key");
      keys.add(i.key);
      // 根拠を出せない断定は、事実として読まれて後で覆る。
      if (i.confidence === "fact" && i.refs.length === 0 && !i.files.some((f) => f.role === "evidence")) {
        at(
          "confidence: fact には refs か evidence のファイルが要る。出せないなら inference にする",
          "confidence",
        );
      }
      const local = (r: string | undefined, field: string) => {
        if (r && !r.includes("#") && !decisions.has(r)) at(`${r} はこの記録の決定に無い`, field);
      };
      if (i.kind === "decision") {
        // 決定の価値は捨てた案にある。棄却理由の無い決定は、同じ案を再検討させる。
        if (!i.options.some((o) => !o.chosen && o.why))
          at("棄却した案と、その理由（why）が 1 つ以上要る", "options");
        if (i.options.some((o) => !o.chosen && !o.why)) at("採らなかった案には why を書く", "options");
        if (i.status === "accepted" && !i.options.some((o) => o.chosen))
          at("採用した決定には chosen: true の案が要る", "options");
        if (i.status === "accepted" && !i.confirmation)
          at("採用した決定には confirmation（守られているかの確かめ方）が要る", "confirmation");
        if (i.supersedes === i.key) at("自分自身は覆せない", "supersedes");
        local(i.supersedes, "supersedes");
      }
      if (i.kind === "verification") {
        if (i.status === "not_run" && !i.reason) at("実行しなかった検証には reason（理由）が要る", "reason");
        local(i.verifies, "verifies");
      }
    });
    // superseded と書いた決定は、この記録の別の決定が覆していなければならない（後継の無い superseded は迷子になる）。
    for (const [n, i] of t.items.entries()) {
      if (i.kind === "decision" && i.status === "superseded") {
        const by = t.items.some((x) => x.kind === "decision" && x.supersedes === i.key);
        if (!by)
          ctx.addIssue({
            code: "custom",
            message: "superseded にするなら、覆した決定の supersedes でこの key を指す",
            path: ["items", n, "status"],
          });
      }
    }
  });

export type Trace = z.infer<typeof traceSchema>;

/** 形を確かめる。問題があれば 1 行ずつの説明を返す。 */
export function checkTrace(
  raw: unknown,
): { trace: Trace; problems: [] } | { trace: null; problems: string[] } {
  const r = traceSchema.safeParse(raw);
  if (r.success) return { trace: r.data, problems: [] };
  return { trace: null, problems: r.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`) };
}

/** その session の要素の key。作業場所の中で一意にする。 */
export const sourceKey = (t: Trace, k: string): string =>
  k.includes("#") ? k : `${t.session.host}:${t.session.id}#${k}`;

type Row = {
  key: string;
  kind: string;
  status: string | null;
  confidence: string | null;
  body: string;
  reason: string | null;
  confirmation: string | null;
  command: string | null;
  downsides: string[];
  refs: string[];
  files: z.infer<typeof file>[];
  at: string;
  /** option の親、verification の確かめた決定（source key） */
  parent: string | null;
  /** この記録の中でこの決定を覆した決定（source key） */
  supersededBy: string | null;
};

/** 記録を行の形へ落とす。決定の案は、決定を親に持つ option の行になる。 */
export function rows(t: Trace): Row[] {
  const out: Row[] = [];
  for (const i of t.items) {
    const base = {
      key: sourceKey(t, i.key),
      kind: i.kind,
      confidence: i.confidence ?? null,
      body: i.text,
      reason: null as string | null,
      confirmation: null as string | null,
      command: null as string | null,
      downsides: [] as string[],
      refs: i.refs,
      files: i.files,
      at: i.at,
      parent: null as string | null,
      supersededBy: null as string | null,
    };
    if (i.kind === "decision") {
      const by = t.items.find(
        (x) => x.kind === "decision" && x.supersedes && sourceKey(t, x.supersedes) === base.key,
      );
      out.push({
        ...base,
        status: i.status,
        reason: i.context,
        confirmation: i.confirmation ?? null,
        downsides: i.downsides,
        supersededBy: by ? sourceKey(t, by.key) : null,
      });
      i.options.forEach((o, n) => {
        out.push({
          ...base,
          key: `${base.key}:o${n + 1}`,
          kind: "option",
          // 覆された・却下された決定の「採った案」を、採用のまま返さない（死んだ設計を推奨する）。
          status: o.chosen
            ? i.status === "superseded" || i.status === "rejected"
              ? "was_chosen"
              : "chosen"
            : "rejected",
          confidence: null,
          body: o.text,
          reason: o.why ?? null,
          refs: [],
          files: [],
          parent: base.key,
        });
      });
    } else if (i.kind === "verification") {
      out.push({
        ...base,
        status: i.status,
        command: i.command ?? null,
        reason: i.reason ?? null,
        parent: i.verifies ? sourceKey(t, i.verifies) : null,
      });
    } else {
      // 行き止まりと分かったことは状態を持たない（表の CHECK が status is null を求める）。
      out.push({ ...base, status: "status" in i ? i.status : null });
    }
  }
  return out;
}

/** 記録を入れる。同じ session の同じ key は上書きし、書かれていない要素は残す（後から足した trace は追記になる）。 */
export async function saveTrace(
  client: pg.Client,
  env: Env,
  projectId: number,
  t: Trace,
): Promise<{ written: number; superseded: number; embedded: number }> {
  const all = rows(t);
  const heading = t.work?.title ?? null;
  const conversation = conversationId(projectId, t.session.host, t.session.id);
  const startedAt =
    t.session.startedAt ?? [...t.items.map((i) => i.at)].sort()[0] ?? new Date().toISOString();

  const result = await inTransaction(client, async () => {
    // 自動記録がこの session を先に作っていれば、そのまま使う（id は同じ規則で決まる）。
    await client.query(
      `insert into mitos.conversation (id, project_id, origin, external_id, branch, started_at)
       values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
      [conversation, projectId, t.session.host, t.session.id, t.session.branch ?? null, startedAt],
    );
    let workId: string | null = null;
    if (t.work) {
      const w = await client.query<{ id: string }>(
        `insert into mitos.work_item (project_id, source_key, title, goal, current, next, status, conversation_id, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (project_id, source_key) do update set
           title = excluded.title, goal = excluded.goal, current = excluded.current, next = excluded.next,
           status = excluded.status, conversation_id = excluded.conversation_id, updated_at = now()
         returning id`,
        [
          projectId,
          t.work.key,
          t.work.title,
          t.work.goal,
          t.work.current,
          t.work.next,
          t.work.status,
          conversation,
        ],
      );
      workId = w.rows[0]?.id ?? null;
    }

    // 別の session の決定を指す参照を、ここで引く。無ければ止める（壊れた参照を黙って落とさない）。
    const idOf = new Map<string, string>();
    const outside = [
      ...new Set(all.flatMap((r) => (r.parent && !all.some((x) => x.key === r.parent) ? [r.parent] : []))),
      ...t.items.flatMap((i) => (i.kind === "decision" && i.supersedes ? [sourceKey(t, i.supersedes)] : [])),
    ].filter((k) => !all.some((x) => x.key === k));
    if (outside.length) {
      const found = await client.query<{ id: string; source_key: string }>(
        "select id, source_key from mitos.knowledge where project_id = $1 and kind = 'decision' and source_key = any($2)",
        [projectId, outside],
      );
      for (const f of found.rows) idOf.set(f.source_key, f.id);
      const missing = outside.filter((k) => !idOf.has(k));
      if (missing.length) throw new Error(`この作業場所に無い決定を指している: ${missing.join(" / ")}`);
    }

    // **DB 側の覆しを優先する。**別の session が後で覆した決定を、古い session の再 trace が「採用」に戻さない。
    const prior = await client.query<{ source_key: string; superseded_by_id: string | null }>(
      "select source_key, superseded_by_id from mitos.knowledge where project_id = $1 and source_key = any($2)",
      [projectId, all.map((r) => r.key)],
    );
    const laterBy = new Map(
      prior.rows.flatMap((p) => (p.superseded_by_id ? [[p.source_key, p.superseded_by_id]] : [])),
    );
    for (const r of all) {
      if (r.kind === "decision" && laterBy.has(r.key) && !r.supersededBy) r.status = "superseded";
      if (r.kind === "option" && r.status === "chosen" && r.parent && laterBy.has(r.parent))
        r.status = "was_chosen";
    }

    // 書く順: 後継の決定 → 覆された決定 → 案と検証。superseded の行は後継の id を持って入る（表の CHECK）。
    const decisions = all.filter((r) => r.kind === "decision");
    const ordered: Row[] = [];
    const placed = new Set<string>();
    while (ordered.length < decisions.length) {
      const next = decisions.filter(
        (d) => !placed.has(d.key) && (!d.supersededBy || placed.has(d.supersededBy)),
      );
      if (next.length === 0) throw new Error("この記録の決定が互いに覆し合っている");
      for (const d of next) {
        ordered.push(d);
        placed.add(d.key);
      }
    }
    ordered.push(...all.filter((r) => r.kind !== "decision"));
    let written = 0;
    for (const r of ordered) {
      const parentId = r.parent ? (idOf.get(r.parent) ?? null) : null;
      const supersededById = r.supersededBy
        ? (idOf.get(r.supersededBy) ?? null)
        : (laterBy.get(r.key) ?? null);
      const embedText = knowledgeText({ kind: r.kind, heading, body: r.body, reason: r.reason });
      const hash = sha256(JSON.stringify([r, heading, workId, parentId, supersededById, embedText]));
      const k = await client.query<{ id: string }>(
        `insert into mitos.knowledge (project_id, conversation_id, work_item_id, source_key, kind, status, confidence,
                                      decision_id, superseded_by_id, heading, body, reason, confirmation, command,
                                      downsides, refs, occurred_at, content_hash, lexemes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $19, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::tsvector)
         on conflict (project_id, source_key) do update set
           conversation_id = excluded.conversation_id, work_item_id = excluded.work_item_id, kind = excluded.kind,
           status = excluded.status, confidence = excluded.confidence, decision_id = excluded.decision_id,
           superseded_by_id = excluded.superseded_by_id, heading = excluded.heading, body = excluded.body,
           reason = excluded.reason, confirmation = excluded.confirmation, command = excluded.command,
           downsides = excluded.downsides, refs = excluded.refs, occurred_at = excluded.occurred_at,
           content_hash = excluded.content_hash, lexemes = excluded.lexemes
         where mitos.knowledge.content_hash <> excluded.content_hash
         returning id`,
        [
          projectId,
          conversation,
          workId,
          r.key,
          r.kind,
          r.status,
          r.confidence,
          parentId,
          heading,
          r.body,
          r.reason,
          r.confirmation,
          r.command,
          r.downsides,
          r.refs,
          r.at,
          hash,
          tsvector([heading, r.body, r.reason].filter(Boolean).join("\n")),
          supersededById,
        ],
      );
      let id = k.rows[0]?.id;
      if (!id) {
        // 変わっていない行。id だけ引く（子の decision_id に要る）。
        const same = await client.query<{ id: string }>(
          "select id from mitos.knowledge where project_id = $1 and source_key = $2",
          [projectId, r.key],
        );
        id = same.rows[0]?.id;
        if (!id) throw new Error(`知識を書けなかった: ${r.key}`);
        idOf.set(r.key, id);
        continue;
      }
      idOf.set(r.key, id);
      written++;
      await client.query("delete from mitos.knowledge_file where knowledge_id = $1", [id]);
      for (const f of r.files) {
        await client.query(
          `insert into mitos.knowledge_file (knowledge_id, path, role, line_start, line_end) values ($1, $2, $3, $4, $4)
           on conflict do nothing`,
          [id, f.path, f.role, f.line ?? null],
        );
      }
      await client.query(
        `insert into mitos.knowledge_embedding (knowledge_id, model, source_hash, status) values ($1, $2, $3, 'pending')
         on conflict (knowledge_id) do update set
           source_hash = excluded.source_hash, status = 'pending', embedding = null, attempts = 0, last_error = null,
           updated_at = now()
         where mitos.knowledge_embedding.source_hash <> excluded.source_hash`,
        [id, EMBED_MODEL, sha256(embedText)],
      );
    }

    // 別の session の決定を覆したら、その決定を superseded にして後継を指す。
    // **消さない** — 消すと、なぜ変えたかが失われて再提案される。この記録の中の決定は上で後継を持って入っている。
    let superseded = 0;
    for (const i of t.items) {
      if (i.kind !== "decision" || !i.supersedes || !i.supersedes.includes("#")) continue;
      const newer = idOf.get(sourceKey(t, i.key));
      const older = idOf.get(sourceKey(t, i.supersedes));
      if (!newer || !older) throw new Error(`覆す決定を引けなかった: ${i.supersedes}`);
      // 輪を作らない。後継の側を遡って older に着くなら、older はもう newer の後にある。
      const loop = await client.query(
        `with recursive chain(id) as (
           select superseded_by_id from mitos.knowledge where id = $1
           union select k.superseded_by_id from mitos.knowledge k join chain c on k.id = c.id
         ) select 1 from chain where id = $2 limit 1`,
        [newer, older],
      );
      if (loop.rowCount) throw new Error(`${i.key} と ${i.supersedes} が互いに覆し合う形になる`);
      const r = await client.query(
        `update mitos.knowledge set status = 'superseded', superseded_by_id = $2
         where id = $1 and (status <> 'superseded' or superseded_by_id is distinct from $2)`,
        [older, newer],
      );
      if (r.rowCount) {
        superseded++;
        // その決定で採った案は「当時は採った案」になる。
        await client.query(
          "update mitos.knowledge set status = 'was_chosen' where decision_id = $1 and kind = 'option' and status = 'chosen'",
          [older],
        );
      }
    }
    return { written, superseded };
  });

  const filled = await fillKnowledge(client, env);
  return { ...result, embedded: filled.embedded };
}
