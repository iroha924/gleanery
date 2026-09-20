// trace の記録を知識（knowledge）と作業の現在地（work_item）へ入れる。
//
// **会話は入れない。**会話は自動記録（capture.ts）が逐語で持っている。trace が選ぶのは、
// 次の判断を誤らないために残す判断だけ — 決定と棄却した案、制約、やらないこと、行き止まり、分かったこと、
// 意図して残した負債、検証、問い。そして「続きをやる」ときに読む作業の現在地。
//
// 形の検査はここに 1 つだけ置き、`gleanery trace check` と `gleanery trace save` が同じ関数を通る。

import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { EMBED_MODEL, type Env } from "./db.ts";
import type { DB } from "./db-types.ts";
import { type Filled, fillKnowledge } from "./embeddings.ts";
import { conversationId, knowledgeText, STATUSES } from "./knowledge.ts";
import { mask, sha256, tsvector } from "./text.ts";

const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const key = z.string().regex(KEY, "小文字英数字と . _ - だけの意味のある語にする");
/** 別の session の決定を指すときは `<host>:<session id>#<key>`。`gleanery trace context` がこの形で出す。 */
const ref = z.string().regex(/^([a-z-]+:[^#\s]+#)?[a-z0-9][a-z0-9._-]*$/, "key か <host>:<session id>#<key>");
const at = z.iso.datetime({
  offset: true,
  message: "ISO 8601 のオフセット付きで書く（例 2026-09-13T10:00:00+09:00）",
});
// 記録は DB と埋め込みの API へ入る。貼ってしまった鍵を伏せてから持つ（自動記録と同じ網）。
const text = z.string().trim().min(1).transform(mask);
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
  refs: z
    .array(
      text.pipe(
        z
          .string()
          .regex(
            /^(commit|url|cmd|issue|pr|doc|file):\S/,
            "commit: / url: / cmd: / issue: / pr: / doc: / file: のどれかを前置する",
          ),
      ),
    )
    .default([]),
  files: z.array(file).default([]),
};

const decision = z
  .object({
    ...common,
    kind: z.literal("decision"),
    status: z.enum(STATUSES.decision),
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
    status: z.enum(STATUSES.verification),
    command: text.optional(),
    /** 実行しなかった理由（not_run のとき） */
    reason: text.optional(),
    /** どの決定を確かめたか */
    verifies: ref.optional(),
  })
  .strict();

const question = z
  .object({ ...common, kind: z.literal("question"), status: z.enum(STATUSES.question) })
  .strict();
// 制約・やらないこと・負債は同じ状態を持つ（knowledge.ts の STATUSES）。
const boundary = z
  .object({
    ...common,
    kind: z.enum(["constraint", "non_goal", "debt"]),
    status: z.enum(STATUSES.constraint),
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
    // superseded と、この記録の中で覆されたことは同じことを 2 通りに書いている。食い違えば止める
    // （後継の無い superseded は迷子になり、覆されたのに有効のままの決定は DB の CHECK で落ちる）。
    for (const [n, i] of t.items.entries()) {
      if (i.kind !== "decision") continue;
      const by = t.items.find((x) => x.kind === "decision" && x.supersedes === i.key);
      const issue = (message: string) =>
        ctx.addIssue({ code: "custom", message, path: ["items", n, "status"] });
      if (i.status === "superseded" && !by)
        issue("superseded にするなら、覆した決定の supersedes でこの key を指す");
      if (by && i.status !== "superseded") issue(`${by.key} が覆しているので、status は superseded にする`);
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

/** `t(...)` の列と対。綴りがずれた列は例外を出さずに null で入るので、ここで型に縛る。 */
type UpsertRow = {
  source_key: string;
  kind: string;
  status: string | null;
  confidence: string | null;
  decision_id: string | null;
  superseded_by_id: string | null;
  work_item_id: string | null;
  heading: string | null;
  body: string;
  reason: string | null;
  confirmation: string | null;
  command: string | null;
  downsides: string[];
  refs: string[];
  occurred_at: string;
  content_hash: string;
  lexemes: string;
};

/** 変わった行だけを書き、書いた行と内容が同じで書かなかった行の両方の id を返す（子の decision_id に要る）。 */
const upsert = (projectId: number, conversation: string, rows: UpsertRow[]) =>
  sql<{ id: string; source_key: string; written: boolean }>`with incoming as (
    select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as t(
      source_key text, kind text, status text, confidence text, decision_id bigint, superseded_by_id bigint,
      work_item_id bigint, heading text, body text, reason text, confirmation text, command text,
      downsides text[], refs text[], occurred_at timestamptz, content_hash text, lexemes text)
  ), written as (
    insert into gleanery.knowledge (project_id, conversation_id, work_item_id, source_key, kind, status, confidence,
                                 decision_id, superseded_by_id, heading, body, reason, confirmation, command,
                                 downsides, refs, occurred_at, content_hash, lexemes)
    select ${projectId}, ${conversation}, t.work_item_id, t.source_key, t.kind, t.status, t.confidence,
           t.decision_id, t.superseded_by_id,
           t.heading, t.body, t.reason, t.confirmation, t.command, t.downsides, t.refs, t.occurred_at,
           decode(t.content_hash, 'hex'), t.lexemes::tsvector
    from incoming t
    on conflict (project_id, source_key) do update set
      conversation_id = excluded.conversation_id, work_item_id = excluded.work_item_id, kind = excluded.kind,
      status = excluded.status, confidence = excluded.confidence, decision_id = excluded.decision_id,
      superseded_by_id = excluded.superseded_by_id, heading = excluded.heading, body = excluded.body,
      reason = excluded.reason, confirmation = excluded.confirmation, command = excluded.command,
      downsides = excluded.downsides, refs = excluded.refs, occurred_at = excluded.occurred_at,
      content_hash = excluded.content_hash, lexemes = excluded.lexemes
    where gleanery.knowledge.content_hash <> excluded.content_hash
    returning id, source_key
  )
  select id::text, source_key, true as written from written
  union all
  select k.id::text, k.source_key, false from gleanery.knowledge k
  where k.project_id = ${projectId} and k.source_key in (select source_key from incoming)
    and k.source_key not in (select source_key from written)`;

/** 記録を入れる。同じ session の同じ key は上書きし、書かれていない要素は残す（後から足した trace は追記になる）。 */
export async function saveTrace(
  db: Kysely<DB>,
  env: Env,
  projectId: number,
  t: Trace,
): Promise<{ written: number; superseded: number; embedding: Filled }> {
  const all = rows(t);
  const conversation = conversationId(projectId, t.session.host, t.session.id);
  // 時刻は文字列ではなく時点で比べる（+09:00 と Z が混ざると辞書順は最早にならない）。
  const earliest = t.items.map((i) => i.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const startedAt = t.session.startedAt ?? earliest ?? new Date().toISOString();

  const result = await db.transaction().execute(async (trx) => {
    // 自動記録がこの session を先に作っていれば、そのまま使う（id は同じ規則で決まる）。
    await trx
      .insertInto("gleanery.conversation")
      .values({
        id: conversation,
        project_id: String(projectId),
        origin: t.session.host,
        external_id: t.session.id,
        branch: t.session.branch ?? null,
        started_at: startedAt,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    let workId: string | null = null;
    if (t.work) {
      const w = await trx
        .insertInto("gleanery.work_item")
        .values({
          project_id: String(projectId),
          source_key: t.work.key,
          title: t.work.title,
          goal: t.work.goal,
          current: t.work.current,
          next: t.work.next,
          status: t.work.status,
          conversation_id: conversation,
          updated_at: sql`now()`,
        })
        .onConflict((oc) =>
          oc.columns(["project_id", "source_key"]).doUpdateSet((eb) => ({
            title: eb.ref("excluded.title"),
            goal: eb.ref("excluded.goal"),
            current: eb.ref("excluded.current"),
            next: eb.ref("excluded.next"),
            status: eb.ref("excluded.status"),
            conversation_id: eb.ref("excluded.conversation_id"),
            updated_at: sql`now()`,
          })),
        )
        .returning("id")
        .executeTakeFirst();
      workId = w?.id ?? null;
    }

    // 別の session の決定を指す参照を、ここで引く。無ければ止める（壊れた参照を黙って落とさない）。
    const idOf = new Map<string, string>();
    const outside = [
      ...new Set([
        ...all.flatMap((r) => (r.parent && !all.some((x) => x.key === r.parent) ? [r.parent] : [])),
        ...t.items.flatMap((i) =>
          i.kind === "decision" && i.supersedes ? [sourceKey(t, i.supersedes)] : [],
        ),
      ]),
    ].filter((k) => !all.some((x) => x.key === k));
    if (outside.length) {
      const found = await trx
        .selectFrom("gleanery.knowledge")
        .select(["id", "source_key"])
        .where("project_id", "=", String(projectId))
        .where("kind", "=", "decision")
        .where(sql<SqlBool>`source_key = any(${outside})`)
        .execute();
      for (const f of found) idOf.set(f.source_key, f.id);
      const missing = outside.filter((k) => !idOf.has(k));
      if (missing.length) throw new Error(`この作業場所に無い決定を指している: ${missing.join(" / ")}`);
    }

    // **DB 側の覆しを優先する。**別の session が後で覆した決定を、古い session の再 trace が「採用」に戻さない。
    // work を省いた再 trace は、既に結んだ作業（とその題の見出し）から要素を外さない。
    // 読んだ行は commit まで掴む。掴まないと、読んでから書くまでの間に別の trace が付けた覆しを上書きで消す。
    const prior = await trx
      .selectFrom("gleanery.knowledge")
      .select(["source_key", "superseded_by_id", "work_item_id", "heading"])
      .where("project_id", "=", String(projectId))
      .where(sql<SqlBool>`source_key = any(${all.map((r) => r.key)})`)
      .forUpdate()
      .execute();
    const laterBy = new Map(
      prior.flatMap((p) => (p.superseded_by_id ? [[p.source_key, p.superseded_by_id]] : [])),
    );
    const priorOf = new Map(prior.map((p) => [p.source_key, p]));
    for (const r of all) {
      if (r.kind === "decision" && laterBy.has(r.key) && !r.supersededBy) r.status = "superseded";
      if (r.kind === "option" && r.status === "chosen" && r.parent && laterBy.has(r.parent))
        r.status = "was_chosen";
    }

    // 書く順: 後継の決定 → 覆された決定 → 案と検証。superseded の行は後継の id を持って入る（表の CHECK）。
    const decisions = all.filter((r) => r.kind === "decision");
    const layers: Row[][] = [];
    const placed = new Set<string>();
    while (placed.size < decisions.length) {
      const next = decisions.filter(
        (d) => !placed.has(d.key) && (!d.supersededBy || placed.has(d.supersededBy)),
      );
      if (next.length === 0) throw new Error("この記録の決定が互いに覆し合っている");
      for (const d of next) placed.add(d.key);
      layers.push(next);
    }
    layers.push(all.filter((r) => r.kind !== "decision"));

    const written: { id: string; row: Row; embedText: string }[] = [];
    for (const layer of layers) {
      if (layer.length === 0) continue;
      const payload = layer.map((r) => {
        const parentId = r.parent ? (idOf.get(r.parent) ?? null) : null;
        const supersededById = r.supersededBy
          ? (idOf.get(r.supersededBy) ?? null)
          : (laterBy.get(r.key) ?? null);
        const work = workId ?? priorOf.get(r.key)?.work_item_id ?? null;
        const heading = t.work ? t.work.title : (priorOf.get(r.key)?.heading ?? null);
        const embedText = knowledgeText({ kind: r.kind, heading, body: r.body, reason: r.reason });
        return {
          row: r,
          embedText,
          json: {
            source_key: r.key,
            kind: r.kind,
            status: r.status,
            confidence: r.confidence,
            decision_id: parentId,
            superseded_by_id: supersededById,
            work_item_id: work,
            heading,
            body: r.body,
            reason: r.reason,
            confirmation: r.confirmation,
            command: r.command,
            downsides: r.downsides,
            refs: r.refs,
            occurred_at: r.at,
            content_hash: sha256(
              JSON.stringify([r, heading, work, parentId, supersededById, embedText]),
            ).toString("hex"),
            lexemes: tsvector([heading, r.body, r.reason].filter(Boolean).join("\n")),
          },
        };
      });
      const got = await upsert(
        projectId,
        conversation,
        payload.map((x) => x.json),
      ).execute(trx);
      const byKey = new Map(payload.map((x) => [x.row.key, x]));
      for (const g of got.rows) {
        idOf.set(g.source_key, g.id);
        const x = byKey.get(g.source_key);
        if (g.written && x) written.push({ id: g.id, row: x.row, embedText: x.embedText });
      }
      const lost = layer.filter((r) => !idOf.has(r.key));
      if (lost.length) throw new Error(`知識を書けなかった: ${lost.map((r) => r.key).join(" / ")}`);
    }

    // 決定を書き直したら、その決定の案は入力の案で置き換える。書き直した案の数が減っても、古い案を棄却として残さない。
    const decisionIds = decisions.map((d) => idOf.get(d.key)).filter((x): x is string => Boolean(x));
    if (decisionIds.length) {
      await trx
        .deleteFrom("gleanery.knowledge")
        .where("project_id", "=", String(projectId))
        .where("kind", "=", "option")
        .where(sql<SqlBool>`decision_id = any(${decisionIds})`)
        .where(sql<SqlBool>`source_key <> all(${all.filter((r) => r.kind === "option").map((r) => r.key)})`)
        .execute();
    }

    // ファイルと埋め込みは書き直した行の分だけ。
    if (written.length) {
      const ids = written.map((w) => w.id);
      await trx
        .deleteFrom("gleanery.knowledge_file")
        .where(sql<SqlBool>`knowledge_id = any(${ids})`)
        .execute();
      const files = written.flatMap((w) => w.row.files.map((f) => ({ id: w.id, ...f })));
      if (files.length) {
        await sql`
          insert into gleanery.knowledge_file (knowledge_id, path, role, line_start, line_end)
          select t.id, t.path, t.role, t.line, t.line
            from unnest(${files.map((f) => f.id)}::bigint[], ${files.map((f) => f.path)}::text[],
                        ${files.map((f) => f.role)}::text[], ${files.map((f) => f.line ?? null)}::int[])
                 as t(id, path, role, line)
          on conflict do nothing`.execute(trx);
      }
      await sql`
        insert into gleanery.knowledge_embedding (knowledge_id, model, source_hash, status)
        select t.id, ${EMBED_MODEL}, t.hash, 'pending'
          from unnest(${ids}::bigint[], ${written.map((w) => sha256(w.embedText))}::bytea[]) as t(id, hash)
        on conflict (knowledge_id) do update set
          source_hash = excluded.source_hash, status = 'pending', embedding = null, attempts = 0, last_error = null,
          updated_at = now()
        where gleanery.knowledge_embedding.source_hash <> excluded.source_hash`.execute(trx);
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
      const loop = await sql`
        with recursive chain(id) as (
          select superseded_by_id from gleanery.knowledge where id = ${newer}
          union select k.superseded_by_id from gleanery.knowledge k join chain c on k.id = c.id
        ) select 1 from chain where id = ${older} limit 1`.execute(trx);
      if (loop.rows.length) throw new Error(`${i.key} と ${i.supersedes} が互いに覆し合う形になる`);
      const r = await trx
        .updateTable("gleanery.knowledge")
        .set({ status: "superseded", superseded_by_id: newer })
        .where("id", "=", older)
        .where(sql`(status <> 'superseded' or superseded_by_id is distinct from ${newer})`.$castTo<boolean>())
        .executeTakeFirst();
      if (Number(r.numUpdatedRows)) {
        superseded++;
        // その決定で採った案は「当時は採った案」になる。
        await trx
          .updateTable("gleanery.knowledge")
          .set({ status: "was_chosen" })
          .where("decision_id", "=", older)
          .where("kind", "=", "option")
          .where("status", "=", "chosen")
          .execute();
      }
    }
    return { written: written.length, superseded };
  });

  return { ...result, embedding: await fillKnowledge(db, env) };
}
