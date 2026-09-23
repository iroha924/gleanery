// trace の記録を知識（knowledge）と作業の現在地（work_item）へ入れる。
//
// **会話は入れない。**会話は自動記録（capture.ts）が逐語で持っている。trace が選ぶのは、
// 次の判断を誤らないために残す判断だけ — 決定と棄却した案、制約、やらないこと、行き止まり、分かったこと、
// 意図して残した負債、検証、問い。そして「続きをやる」ときに読む作業の現在地。
//
// 形の検査はここに 1 つだけ置き、`gleanery trace check` と `gleanery trace save` が同じ関数を通る。

import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { inTransaction, iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { conversationId, STATUSES } from "./knowledge.ts";
import { mask, sha256 } from "./text.ts";

const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const key = z.string().regex(KEY, "小文字英数字と . _ - だけの意味のある語にする");
/** 別の session の決定を指すときは `<host>:<session id>#<key>`。`gleanery trace context` がこの形で出す。 */
const ref = z.string().regex(/^([a-z-]+:[^#\s]+#)?[a-z0-9][a-z0-9._-]*$/, "key か <host>:<session id>#<key>");
const at = z.iso.datetime({
  offset: true,
  message: "ISO 8601 のオフセット付きで書く（例 2026-09-13T10:00:00+09:00）",
});
// 記録は DB へ入り、MCP から引かれる。貼ってしまった鍵を伏せてから持つ（自動記録と同じ網）。
const text = z.string().trim().min(1).transform(mask);
const file = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (p) => !p.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(p),
        "プロジェクトのルートからの相対パスにする",
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
  return {
    trace: null,
    problems: r.error.issues.map((i) => `${i.path.join(".") || "(ルート)"}: ${i.message}`),
  };
}

/** その session の要素の key。プロジェクトの中で一意にする。 */
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

// 1 文で渡す変数の数を SQLite の上限（32,766）より十分下に保つ。知識は 1 行 18 列。
const CHUNK = 500;
const chunks = <T>(xs: T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** 記録を入れる。同じ session の同じ key は上書きし、書かれていない要素は残す（後から足した trace は追記になる）。 */
export async function saveTrace(
  db: Kysely<DB>,
  projectId: number,
  t: Trace,
): Promise<{ written: number; superseded: number }> {
  const all = rows(t);
  const conversation = conversationId(projectId, t.session.host, t.session.id);
  // 時刻は文字列ではなく時点で比べる（+09:00 と Z が混ざると辞書順は最早にならない）。
  const earliest = t.items.map((i) => i.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const startedAt = iso(t.session.startedAt ?? earliest ?? Date.now());

  return inTransaction(db, async (trx) => {
    // 自動記録がこの session を先に作っていれば、そのまま使う（id は同じ規則で決まる）。
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

    // 別の session の決定を指す参照を、ここで引く。無ければ止める（壊れた参照を黙って落とさない）。
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
    if (missing.length) throw new Error(`このプロジェクトに無い決定を指している: ${missing.join(" / ")}`);

    // **DB 側の覆しを優先する。**別の session が後で覆した決定を、古い session の再 trace が「採用」に戻さない。
    // work を省いた再 trace は、既に結んだ作業（とその題の見出し）から要素を外さない。
    // 読んでから書くまでの間に別の trace が覆しを付けることは無い（inTransaction が書き込みのロックを先に取る）。
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
        // 内容の hash が変わった行だけを書き換える。書き換えなかった行は returning に出ない。
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
        // 書かなかった行（内容が同じ）の id も要る（子の decision_id）。
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
      if (lost.length) throw new Error(`知識を書けなかった: ${lost.map((r) => r.key).join(" / ")}`);
    }

    // 決定を書き直したら、その決定の案は入力の案で置き換える。書き直した案の数が減っても、古い案を棄却として残さない。
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

    // ファイルは書き直した行の分だけ。
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
          select superseded_by_id from knowledge where id = ${newer}
          union select k.superseded_by_id from knowledge k join chain c on k.id = c.id
        ) select 1 from chain where id = ${older} limit 1`.execute(trx);
      if (loop.rows.length) throw new Error(`${i.key} と ${i.supersedes} が互いに覆し合う形になる`);
      const r = await trx
        .updateTable("knowledge")
        .set({ status: "superseded", superseded_by_id: newer })
        .where("id", "=", older)
        .where(sql<SqlBool>`(status <> 'superseded' or superseded_by_id is not ${newer})`)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows)) {
        superseded++;
        // その決定で採った案は「当時は採った案」になる。
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
