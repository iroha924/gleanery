// Stores trace records as knowledge and as where work stands (work_item).
//
// **Conversations are not stored here.** Recording (capture.ts) keeps them verbatim. trace picks only
// what keeps the next decision from going wrong — decisions and rejected options, constraints, non-goals, dead ends, findings,
// intentional debt, verifications, questions — plus where work stands, read when continuing it.
//
// Shape validation lives here only; `gleanery trace check` and `gleanery trace save` go through the same function.

import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { inTransaction, iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { conversationId, STATUSES } from "./knowledge.ts";
import { mask, sha256 } from "./text.ts";

const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const key = z.string().regex(KEY, "use a meaningful word of lowercase letters, digits, and . _ - only");
/** A decision in another session is `<host>:<session id>#<key>`. `gleanery trace context` prints this form. */
const ref = z
  .string()
  .regex(/^([a-z-]+:[^#\s]+#)?[a-z0-9][a-z0-9._-]*$/, "a key, or <host>:<session id>#<key>");
const at = z.iso.datetime({
  offset: true,
  message: "use ISO 8601 with an offset (for example 2026-09-13T10:00:00+09:00)",
});
// Records go into the database and are read through MCP. Pasted keys are masked before storing (the same filter as recording).
const text = z.string().trim().min(1).transform(mask);
const file = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (p) => !p.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(p),
        "use a path relative to the project root",
      ),
    role: z.enum(["applies_to", "evidence"]),
    line: z.number().int().positive().optional(),
  })
  .strict();

const common = {
  key,
  at,
  text,
  confidence: z.enum(["fact", "inference", "opinion"]).optional(),
  /** Evidence other than files, prefixed with its kind: `commit:<sha>`, `url:<URL>`, `cmd:<command>`, `issue:#<number>` */
  refs: z
    .array(
      text.pipe(
        z
          .string()
          .regex(
            /^(commit|url|cmd|issue|pr|doc|file):\S/,
            "prefix it with one of commit: / url: / cmd: / issue: / pr: / doc: / file:",
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
    /** The forces at play at the time: why this decision was needed */
    context: text,
    options: z.array(z.object({ text, chosen: z.boolean(), why: text.optional() }).strict()).min(1),
    /** How to check that this decision is being kept */
    confirmation: text.optional(),
    /** Downsides knowingly accepted */
    downsides: z.array(text).default([]),
    /** The decision this one supersedes */
    supersedes: ref.optional(),
  })
  .strict();

const verification = z
  .object({
    ...common,
    kind: z.literal("verification"),
    status: z.enum(STATUSES.verification),
    command: text.optional(),
    /** Why it was not run (when not_run) */
    reason: text.optional(),
    /** Which decision it checked */
    verifies: ref.optional(),
  })
  .strict();

const question = z
  .object({ ...common, kind: z.literal("question"), status: z.enum(STATUSES.question) })
  .strict();
// Constraints, non-goals, and debt share the same statuses (knowledge.ts STATUSES).
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
        /** Stated so that success can be measured */
        goal: text,
        current: text,
        /** What to do next. Items a person must do start with the Japanese "person:" prefix (see the trace Skill) */
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
      if (keys.has(i.key)) at(`key ${i.key} is duplicated`, "key");
      keys.add(i.key);
      // Assertions without evidence are read as facts and later overturned.
      if (i.confidence === "fact" && i.refs.length === 0 && !i.files.some((f) => f.role === "evidence")) {
        at("confidence: fact needs refs or evidence files. Without them, use inference", "confidence");
      }
      const local = (r: string | undefined, field: string) => {
        if (r && !r.includes("#") && !decisions.has(r)) at(`${r} is not a decision in this record`, field);
      };
      if (i.kind === "decision") {
        // A decision's value lies in the options it dropped. A decision without reasons for rejection invites the same options again.
        if (!i.options.some((o) => !o.chosen && o.why))
          at("needs at least one rejected option with its reason (why)", "options");
        if (i.options.some((o) => !o.chosen && !o.why))
          at("write why for every option not chosen", "options");
        if (i.status === "accepted" && !i.options.some((o) => o.chosen))
          at("an accepted decision needs an option with chosen: true", "options");
        if (i.status === "accepted" && !i.confirmation)
          at("an accepted decision needs confirmation (how to check it is kept)", "confirmation");
        if (i.supersedes === i.key) at("a decision cannot supersede itself", "supersedes");
        local(i.supersedes, "supersedes");
      }
      if (i.kind === "verification") {
        if (i.status === "not_run" && !i.reason)
          at("a verification that was not run needs a reason", "reason");
        local(i.verifies, "verifies");
      }
    });
    // superseded, and being superseded within this record, say the same thing two ways. Stop when they disagree
    // (a superseded decision without a successor is lost, and a superseded decision still in effect fails the database CHECK).
    for (const [n, i] of t.items.entries()) {
      if (i.kind !== "decision") continue;
      const by = t.items.find((x) => x.kind === "decision" && x.supersedes === i.key);
      const issue = (message: string) =>
        ctx.addIssue({ code: "custom", message, path: ["items", n, "status"] });
      if (i.status === "superseded" && !by)
        issue("to mark it superseded, point supersedes of the newer decision at this key");
      if (by && i.status !== "superseded") issue(`${by.key} supersedes it, so set status to superseded`);
    }
  });

export type Trace = z.infer<typeof traceSchema>;

/** Validates the shape. Returns one line per problem. */
export function checkTrace(
  raw: unknown,
): { trace: Trace; problems: [] } | { trace: null; problems: string[] } {
  const r = traceSchema.safeParse(raw);
  if (r.success) return { trace: r.data, problems: [] };
  return {
    trace: null,
    problems: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/** Keys of the session's elements. Unique within the project. */
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
  /** The parent of an option, or the decision a verification checked (source key) */
  parent: string | null;
  /** The decision in this record that superseded this one (source key) */
  supersededBy: string | null;
};

/** Turns a record into rows. A decision's options become option rows whose parent is the decision. */
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
          // Never return the chosen option of a superseded or rejected decision as chosen (that recommends a dead design).
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
      // Dead ends and findings have no status (the table CHECK requires status is null).
      out.push({ ...base, status: "status" in i ? i.status : null });
    }
  }
  return out;
}

// Keep the number of variables per statement well below SQLite's limit (32,766). Knowledge rows have 18 columns.
const CHUNK = 500;
const chunks = <T>(xs: T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** Stores a record. The same key in the same session is overwritten; elements not written stay (a later trace appends). */
export async function saveTrace(
  db: Kysely<DB>,
  projectId: number,
  t: Trace,
): Promise<{ written: number; superseded: number }> {
  const all = rows(t);
  const conversation = conversationId(projectId, t.session.host, t.session.id);
  // Compare times as instants, not strings (with +09:00 and Z mixed, lexical order is not the earliest).
  const earliest = t.items.map((i) => i.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const startedAt = iso(t.session.startedAt ?? earliest ?? Date.now());

  return inTransaction(db, async (trx) => {
    // If recording created this session first, use it (ids follow the same rule).
    await trx
      .insertInto("conversation")
      .values({
        id: conversation,
        project_id: projectId,
        origin: t.session.host,
        external_id: t.session.id,
        branch: t.session.branch ?? null,
        started_at: startedAt,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    let workId: number | null = null;
    if (t.work) {
      const now = iso(Date.now());
      const w = await trx
        .insertInto("work_item")
        .values({
          project_id: projectId,
          source_key: t.work.key,
          title: t.work.title,
          goal: t.work.goal,
          current: t.work.current,
          next: JSON.stringify(t.work.next),
          status: t.work.status,
          conversation_id: conversation,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["project_id", "source_key"]).doUpdateSet((eb) => ({
            title: eb.ref("excluded.title"),
            goal: eb.ref("excluded.goal"),
            current: eb.ref("excluded.current"),
            next: eb.ref("excluded.next"),
            status: eb.ref("excluded.status"),
            conversation_id: eb.ref("excluded.conversation_id"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .returning("id")
        .executeTakeFirst();
      workId = w?.id ?? null;
    }

    // Resolve references to decisions in other sessions here. Stop when missing (never drop a broken reference silently).
    const idOf = new Map<string, number>();
    const outside = [
      ...new Set([
        ...all.flatMap((r) => (r.parent && !all.some((x) => x.key === r.parent) ? [r.parent] : [])),
        ...t.items.flatMap((i) =>
          i.kind === "decision" && i.supersedes ? [sourceKey(t, i.supersedes)] : [],
        ),
      ]),
    ].filter((k) => !all.some((x) => x.key === k));
    for (const part of chunks(outside))
      for (const f of await trx
        .selectFrom("knowledge")
        .select(["id", "source_key"])
        .where("project_id", "=", projectId)
        .where("kind", "=", "decision")
        .where("source_key", "in", part)
        .execute())
        idOf.set(f.source_key, f.id);
    const missing = outside.filter((k) => !idOf.has(k));
    if (missing.length) throw new Error(`Points to decisions not in this project: ${missing.join(" / ")}`);

    // **Supersessions in the database win.** Re-tracing an old session never returns a decision superseded later by another session to accepted.
    // A re-trace without work never removes elements from work already linked (or from its title heading).
    // No other trace can add a supersession between the read and the write (inTransaction takes the write lock first).
    const prior: {
      source_key: string;
      superseded_by_id: number | null;
      work_item_id: number | null;
      heading: string | null;
    }[] = [];
    for (const part of chunks(all.map((r) => r.key)))
      prior.push(
        ...(await trx
          .selectFrom("knowledge")
          .select(["source_key", "superseded_by_id", "work_item_id", "heading"])
          .where("project_id", "=", projectId)
          .where("source_key", "in", part)
          .execute()),
      );
    const laterBy = new Map(
      prior.flatMap((p) => (p.superseded_by_id ? [[p.source_key, p.superseded_by_id]] : [])),
    );
    const priorOf = new Map(prior.map((p) => [p.source_key, p]));
    for (const r of all) {
      if (r.kind === "decision" && laterBy.has(r.key) && !r.supersededBy) r.status = "superseded";
      if (r.kind === "option" && r.status === "chosen" && r.parent && laterBy.has(r.parent))
        r.status = "was_chosen";
    }

    // Write order: successor decisions, superseded decisions, then options and verifications. Superseded rows carry the successor id (the table CHECK).
    const decisions = all.filter((r) => r.kind === "decision");
    const layers: Row[][] = [];
    const placed = new Set<string>();
    while (placed.size < decisions.length) {
      const next = decisions.filter(
        (d) => !placed.has(d.key) && (!d.supersededBy || placed.has(d.supersededBy)),
      );
      if (next.length === 0) throw new Error("Decisions in this record supersede each other");
      for (const d of next) placed.add(d.key);
      layers.push(next);
    }
    layers.push(all.filter((r) => r.kind !== "decision"));

    const written: { id: number; row: Row }[] = [];
    for (const layer of layers) {
      for (const part of chunks(layer)) {
        const values = part.map((r) => {
          const parentId = r.parent ? (idOf.get(r.parent) ?? null) : null;
          const supersededById = r.supersededBy
            ? (idOf.get(r.supersededBy) ?? null)
            : (laterBy.get(r.key) ?? null);
          const work = workId ?? priorOf.get(r.key)?.work_item_id ?? null;
          const heading = t.work ? t.work.title : (priorOf.get(r.key)?.heading ?? null);
          return {
            project_id: projectId,
            conversation_id: conversation,
            work_item_id: work,
            source_key: r.key,
            kind: r.kind,
            status: r.status,
            confidence: r.confidence,
            decision_id: parentId,
            superseded_by_id: supersededById,
            heading,
            body: r.body,
            reason: r.reason,
            confirmation: r.confirmation,
            command: r.command,
            downsides: JSON.stringify(r.downsides),
            refs: JSON.stringify(r.refs),
            occurred_at: iso(r.at),
            content_hash: sha256(JSON.stringify([r, heading, work, parentId, supersededById])),
          };
        });
        // Rewrite only rows whose content hash changed. Unchanged rows do not appear in returning.
        const got = await trx
          .insertInto("knowledge")
          .values(values)
          .onConflict((oc) =>
            oc
              .columns(["project_id", "source_key"])
              .doUpdateSet((eb) => ({
                conversation_id: eb.ref("excluded.conversation_id"),
                work_item_id: eb.ref("excluded.work_item_id"),
                kind: eb.ref("excluded.kind"),
                status: eb.ref("excluded.status"),
                confidence: eb.ref("excluded.confidence"),
                decision_id: eb.ref("excluded.decision_id"),
                superseded_by_id: eb.ref("excluded.superseded_by_id"),
                heading: eb.ref("excluded.heading"),
                body: eb.ref("excluded.body"),
                reason: eb.ref("excluded.reason"),
                confirmation: eb.ref("excluded.confirmation"),
                command: eb.ref("excluded.command"),
                downsides: eb.ref("excluded.downsides"),
                refs: eb.ref("excluded.refs"),
                occurred_at: eb.ref("excluded.occurred_at"),
                content_hash: eb.ref("excluded.content_hash"),
              }))
              .where("knowledge.content_hash", "<>", (eb) => eb.ref("excluded.content_hash")),
          )
          .returning(["id", "source_key"])
          .execute();
        const byKey = new Map(part.map((r) => [r.key, r]));
        for (const g of got) {
          const row = byKey.get(g.source_key);
          if (row) written.push({ id: g.id, row });
        }
        // The ids of rows not written (same content) are needed too (children's decision_id).
        for (const k of await trx
          .selectFrom("knowledge")
          .select(["id", "source_key"])
          .where("project_id", "=", projectId)
          .where(
            "source_key",
            "in",
            part.map((r) => r.key),
          )
          .execute())
          idOf.set(k.source_key, k.id);
      }
      const lost = layer.filter((r) => !idOf.has(r.key));
      if (lost.length) throw new Error(`Could not write knowledge: ${lost.map((r) => r.key).join(" / ")}`);
    }

    // When a decision is rewritten, its options are replaced by the input's. Even with fewer options, old ones are not kept as rejected.
    const decisionIds = decisions.flatMap((d) => idOf.get(d.key) ?? []);
    const options = new Set(all.filter((r) => r.kind === "option").map((r) => r.key));
    const stale: number[] = [];
    for (const part of chunks(decisionIds))
      for (const o of await trx
        .selectFrom("knowledge")
        .select(["id", "source_key"])
        .where("project_id", "=", projectId)
        .where("kind", "=", "option")
        .where("decision_id", "in", part)
        .execute())
        if (!options.has(o.source_key)) stale.push(o.id);
    for (const part of chunks(stale)) await trx.deleteFrom("knowledge").where("id", "in", part).execute();

    // Files only for the rows rewritten.
    for (const part of chunks(written.map((w) => w.id)))
      await trx.deleteFrom("knowledge_file").where("knowledge_id", "in", part).execute();
    const files = written.flatMap((w) =>
      w.row.files.map((f) => ({
        knowledge_id: w.id,
        path: f.path,
        role: f.role,
        line_start: f.line ?? null,
        line_end: f.line ?? null,
      })),
    );
    for (const part of chunks(files))
      await trx
        .insertInto("knowledge_file")
        .values(part)
        .onConflict((oc) => oc.doNothing())
        .execute();

    // When a decision from another session is superseded, mark it superseded and point to the successor.
    // **Never delete it** — deleting loses why it changed and invites re-proposals. Decisions in this record already carry their successor above.
    let superseded = 0;
    for (const i of t.items) {
      if (i.kind !== "decision" || !i.supersedes || !i.supersedes.includes("#")) continue;
      const newer = idOf.get(sourceKey(t, i.key));
      const older = idOf.get(sourceKey(t, i.supersedes));
      if (!newer || !older) throw new Error(`Could not find the decision to supersede: ${i.supersedes}`);
      // No cycles. If walking back from the successor reaches older, older is already after newer.
      const loop = await sql`
        with recursive chain(id) as (
          select superseded_by_id from knowledge where id = ${newer}
          union select k.superseded_by_id from knowledge k join chain c on k.id = c.id
        ) select 1 from chain where id = ${older} limit 1`.execute(trx);
      if (loop.rows.length) throw new Error(`${i.key} and ${i.supersedes} would supersede each other`);
      const r = await trx
        .updateTable("knowledge")
        .set({ status: "superseded", superseded_by_id: newer })
        .where("id", "=", older)
        .where(sql<SqlBool>`(status <> 'superseded' or superseded_by_id is not ${newer})`)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows)) {
        superseded++;
        // The option chosen in that decision becomes "chosen then".
        await trx
          .updateTable("knowledge")
          .set({ status: "was_chosen" })
          .where("decision_id", "=", older)
          .where("kind", "=", "option")
          .where("status", "=", "chosen")
          .execute();
      }
    }
    return { written: written.length, superseded };
  });
}
