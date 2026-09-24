// Extracts decisions from lines in a fixed format in the decisions section of merged PR bodies.
// No generative AI reads them (there is no API). Bullets that do not fit the format are skipped and counted (free text in old PRs is not extracted).
// The format is defined in .github/pull_request_template.md.

import type { Kysely } from "kysely";
import { Lexer, type Token, type Tokens } from "marked";
import { iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { sha256 } from "./text.ts";

type Rejected = { text: string; reason: string | null };
export type Extracted = { line: string; chosen: string; rejected: Rejected[] };

/**
 * One PR body format. The English one is the template since #144; the Japanese one is still read so older PRs keep their decisions.
 * Only top-level chosen-option bullets directly under the section are accepted (no tasks, numbered items, other markers, or nesting).
 */
type Dialect = {
  section: string;
  item: RegExp;
  chosen: RegExp;
  /** Full stops that may come right before the rejection marker */
  stops: string;
  rejected: RegExp;
  bare: RegExp;
  /** Characters that separate rejected options, outside parentheses and code */
  commas: string;
  trailing: RegExp;
};

const DIALECTS: Dialect[] = [
  {
    // Bodies under the English headings are often written in Japanese, so Japanese punctuation is accepted too
    section: "Decisions",
    item: /^- Chosen:/,
    chosen: /^Chosen:\s*(.*)$/,
    // english-exempt: accepts the Japanese full stop in bodies written in Japanese
    stops: ".。",
    // english-exempt: accepts the Japanese full stop in bodies written in Japanese
    rejected: /^[.。]\s*Rejected:\s*/,
    bare: /\bRejected:/,
    // english-exempt: accepts the Japanese comma in bodies written in Japanese
    commas: ",、",
    // english-exempt: accepts the Japanese full stop in bodies written in Japanese
    trailing: /[.。]$/,
  },
  {
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    section: "採った案と棄却した案",
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    item: /^- 採った[:：]/,
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    chosen: /^採った[:：]\s*(.*)$/,
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    stops: "。",
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    rejected: /^。\s*棄却[:：]\s*/,
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    bare: /棄却[:：]/,
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    commas: "、",
    // english-exempt: reads the Japanese PR format so older PR bodies keep their decisions
    trailing: /。$/,
  },
];
// english-exempt: PR bodies written in Japanese use full-width parentheses for reasons
const PAIRS: Record<string, string> = { "（": "）", "(": ")" };
const CLOSERS = new Set(Object.values(PAIRS));
/** Inline tokens that cannot appear inside. Lines with HTML are skipped whole (no splitting at separators inside comments) */
const REFUSED = new Set(["html"]);

/** Children of a token (inside emphasis, links, quotes, and so on). */
const children = (t: Token): Token[] =>
  "tokens" in t && Array.isArray(t.tokens) ? (t.tokens as Token[]) : [];

/** Copies one token's raw text with code and escapes masked by symbols of the same length. Children are found in the raw text and masked. */
function maskToken(t: Token): string | null {
  if (REFUSED.has(t.type)) return null;
  if (t.type === "codespan" || t.type === "escape") return "_".repeat(t.raw.length);
  const kids = children(t);
  if (kids.length === 0) return t.raw;
  const inner = kids.map((k) => k.raw).join("");
  const at = t.raw.indexOf(inner);
  if (at < 0) return null;
  let out = "";
  for (const k of kids) {
    const m = maskToken(k);
    if (m === null) return null;
    out += m;
  }
  return t.raw.slice(0, at) + out + t.raw.slice(at + inner.length);
}

/**
 * A copy with inline code and escapes masked by symbols of the same length. marked's inline lexer decides what they are.
 * Lines with HTML, and lines whose masked copy has a different length, are null (skipped whole).
 */
function masked(s: string): string | null {
  let out = "";
  for (const t of Lexer.lexInline(s)) {
    const m = maskToken(t);
    if (m === null) return null;
    out += m;
  }
  return out.length === s.length ? out : null;
}

/** The position outside parentheses that satisfies at. Opening and closing parentheses must match in kind. null if unbalanced. */
function outside(m: string, at: (i: number) => boolean): number[] | null {
  const stack: string[] = [];
  const hits: number[] = [];
  for (let i = 0; i < m.length; i++) {
    const c = m[i] ?? "";
    if (c in PAIRS) stack.push(PAIRS[c] ?? "");
    else if (CLOSERS.has(c)) {
      if (stack.pop() !== c) return null;
    } else if (stack.length === 0 && at(i)) hits.push(i);
  }
  return stack.length === 0 ? hits : null;
}

/** Splits a trailing parenthesis (full-width or half-width) off as the reason. s is the original, m the masked copy. An empty option is null. */
function withReason(s: string, m: string, d: Dialect): Rejected | null {
  const lead = s.length - s.trimStart().length;
  const text0 = s.trim().replace(d.trailing, "");
  const mask = m.slice(lead, lead + text0.length);
  if (!text0) return null;
  const close = mask.at(-1) ?? "";
  if (!CLOSERS.has(close)) return { text: text0, reason: null };
  let depth = 0;
  for (let i = mask.length - 1; i >= 0; i--) {
    const c = mask[i] ?? "";
    if (CLOSERS.has(c)) depth++;
    else if (c in PAIRS && --depth === 0) {
      if (PAIRS[c] !== close) return null;
      const text = text0.slice(0, i).trim();
      return text ? { text, reason: text0.slice(i + 1, -1).trim() || null } : null;
    }
  }
  return null;
}

/** The number of list items under a token (including nesting through quotes and the like). */
const nestedItems = (tokens: Token[]): number =>
  tokens.reduce((n, x) => n + (x.type === "list" ? count(x as Tokens.List) : nestedItems(children(x))), 0);
/** The number of list items (including nested ones). */
const count = (t: Tokens.List): number => t.items.reduce((n, item) => n + 1 + nestedItems(item.tokens), 0);

/** The first lines of chosen-option items directly under the section, and the number of rejected bullets. marked (CommonMark) interprets headings, code, HTML, and lists. */
function sectionItems(body: string): { lines: string[]; refused: number; dialect: Dialect } {
  const lines: string[] = [];
  let refused = 0;
  let inside: Dialect | null = null;
  let found: Dialect = DIALECTS[0] as Dialect;
  for (const t of Lexer.lex(body)) {
    if (t.type === "heading" && t.depth <= 2) {
      if (inside) break;
      inside = t.depth === 2 ? (DIALECTS.find((d) => d.section === t.text.trim()) ?? null) : null;
      if (inside) found = inside;
      continue;
    }
    if (!inside || t.type !== "list") continue;
    const list = t as Tokens.List;
    if (list.ordered) {
      refused += count(list);
      continue;
    }
    for (const item of list.items) {
      refused += nestedItems(item.tokens);
      const first = (item.raw.split("\n")[0] ?? "").trimEnd();
      if (item.task || !inside.item.test(first)) refused++;
      else lines.push(first);
    }
  }
  return { lines, refused, dialect: found };
}

export function extractDecisions(body: string): { decisions: Extracted[]; skipped: number } {
  const decisions: Extracted[] = [];
  const { lines, refused, dialect } = sectionItems(body);
  let skipped = refused;
  for (const line of lines) {
    const parsed = parse(line, dialect);
    if (parsed) decisions.push(parsed);
    else skipped++;
  }
  return { decisions, skipped };
}

/** One decision line in the PR format. null if it does not fit. */
function parse(line: string, d: Dialect): Extracted | null {
  const content = line.slice(2);
  const all = masked(content);
  if (all === null) return null;
  const head = d.chosen.exec(content);
  if (!head) return null;
  const from = content.length - (head[1] ?? "").length;
  const rest = content.slice(from);
  const m = all.slice(from);
  // Split only at the first rejection marker that follows a full stop, outside parentheses and code
  const cut = outside(m, (i) => d.stops.includes(m[i] ?? "") && d.rejected.test(m.slice(i)));
  if (!cut) return null;
  const at = cut[0];
  if (at === undefined) {
    const chosen = rest.trim().replace(d.trailing, "");
    return d.bare.test(m) || !chosen ? null : { line, chosen, rejected: [] };
  }
  const chosen = rest.slice(0, at).trim();
  const skip = d.rejected.exec(m.slice(at))?.[0].length ?? 0;
  const tail = rest.slice(at + skip);
  const tm = m.slice(at + skip);
  const commas = outside(tm, (i) => d.commas.includes(tm[i] ?? ""));
  if (!chosen || !commas) return null;
  const bounds = [-1, ...commas, tail.length];
  const rejected = bounds.slice(1).map((end, i) => {
    const start = (bounds[i] ?? -1) + 1;
    return withReason(tail.slice(start, end), tm.slice(start, end), d);
  });
  if (rejected.some((r) => r === null)) return null;
  return { line, chosen, rejected: rejected as Rejected[] };
}

/** Version of the extraction rules. Bump it when the format or line shape changes (the next sync rewrites every row's content and keeps statuses). */
const RULE = 2;

/** Candidate PRs for extraction. The body is the message with external_id "body", and the author is the GitHub user id. */
export type PrForDecisions = {
  number: number;
  merged: boolean;
  mergedAt: string | null;
  url: string;
  sourceItemId: number;
  conversationId: string;
  body: string | null;
  authorId: number | null;
};

type Row = {
  key: string;
  kind: "decision" | "option";
  status: "accepted" | "chosen" | "rejected";
  body: string;
  reason: string | null;
  parent: string | null;
  pr: PrForDecisions;
  heading: string;
};

const CHUNK = 500;
const chunks = <T>(xs: T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Syncs knowledge with decisions extracted from the owner's merged PR bodies. db is the ingest connection inside the sync transaction.
 * Existing rows keep their status and superseded_by_id (a resync never undoes a decision overturned by trace).
 * Remaining rows are updated, and only rows that disappeared (removed from the body, no longer the owner's, or merge undone) are deleted.
 */
export async function syncDecisions(
  db: Kysely<DB>,
  projectId: number,
  repo: string,
  prs: PrForDecisions[],
): Promise<{ written: number; skipped: number; unlinked: boolean }> {
  const self = new Set(
    (
      await db
        .selectFrom("person_identity as i")
        .innerJoin("person as p", "p.id", "i.person_id")
        .select("i.external_id")
        .where("i.provider", "=", "github")
        .where("p.is_self", "=", 1)
        .execute()
    ).map((r) => r.external_id),
  );
  const rows: Row[] = [];
  let skipped = 0;
  for (const pr of prs) {
    if (!pr.merged || !pr.body || pr.authorId === null || !self.has(String(pr.authorId))) continue;
    const got = extractDecisions(pr.body);
    // Bodies with no decisions at all (free text in old PRs) are not counted. Only format typos are reported
    if (got.decisions.length) skipped += got.skipped;
    const heading = `Decisions in PR #${pr.number} (${(pr.mergedAt ?? "").slice(0, 10)})`;
    const seen = new Map<string, number>();
    for (const d of got.decisions) {
      const h = sha256(d.line).toString("hex").slice(0, 12);
      const n = (seen.get(h) ?? 0) + 1;
      seen.set(h, n);
      const key = `github:${repo}/pull/${pr.number}#${h}-${n}`;
      const row = { pr, heading, reason: null, parent: null };
      rows.push({ ...row, key, kind: "decision", status: "accepted", body: d.chosen });
      rows.push({ ...row, key: `${key}.c`, kind: "option", status: "chosen", body: d.chosen, parent: key });
      for (const [i, r] of d.rejected.entries())
        rows.push({
          ...row,
          key: `${key}.r${i + 1}`,
          kind: "option",
          status: "rejected",
          body: r.text,
          reason: r.reason,
          parent: key,
        });
    }
  }

  // Delete removed rows first. Rows built from PRs are identified by source_item and the github: key (trace and document rows are untouched)
  const keep = new Set(rows.map((r) => r.key));
  const stale: number[] = [];
  for (const part of chunks(prs.map((p) => p.sourceItemId)))
    for (const k of await db
      .selectFrom("knowledge")
      .select(["id", "source_key"])
      .where("project_id", "=", projectId)
      .where("source_item_id", "in", part)
      .where("source_key", "like", "github:%")
      .execute())
      if (!keep.has(k.source_key)) stale.push(k.id);
  for (const part of chunks(stale)) await db.deleteFrom("knowledge").where("id", "in", part).execute();

  let written = 0;
  const idOf = new Map<string, number>();
  for (const layer of [rows.filter((r) => r.kind === "decision"), rows.filter((r) => r.kind === "option")]) {
    for (const part of chunks(layer)) {
      const values = part.map((r) => {
        const refs = JSON.stringify([r.pr.url]);
        const occurred = iso(r.pr.mergedAt ?? Date.now());
        return {
          project_id: projectId,
          source_item_id: r.pr.sourceItemId,
          conversation_id: r.pr.conversationId,
          source_key: r.key,
          kind: r.kind,
          status: r.status,
          decision_id: r.parent ? (idOf.get(r.parent) ?? null) : null,
          heading: r.heading,
          body: r.body,
          reason: r.reason,
          refs,
          occurred_at: occurred,
          content_hash: sha256(
            JSON.stringify([RULE, r.kind, r.status, r.body, r.reason, r.heading, refs, occurred, r.parent]),
          ),
        };
      });
      // status and superseded_by_id are never rewritten. Only rows whose content hash changed are written
      const got = await db
        .insertInto("knowledge")
        .values(values)
        .onConflict((oc) =>
          oc
            .columns(["project_id", "source_key"])
            .doUpdateSet((eb) => ({
              source_item_id: eb.ref("excluded.source_item_id"),
              conversation_id: eb.ref("excluded.conversation_id"),
              decision_id: eb.ref("excluded.decision_id"),
              heading: eb.ref("excluded.heading"),
              body: eb.ref("excluded.body"),
              reason: eb.ref("excluded.reason"),
              refs: eb.ref("excluded.refs"),
              occurred_at: eb.ref("excluded.occurred_at"),
              content_hash: eb.ref("excluded.content_hash"),
            }))
            .where("knowledge.content_hash", "<>", (eb) => eb.ref("excluded.content_hash")),
        )
        .returning("id")
        .execute();
      written += got.length;
    }
    // Options link by decision id. Decisions that were not rewritten do not appear in returning, so look them up by key
    if (layer[0]?.kind === "decision")
      for (const part of chunks(layer.map((r) => r.key)))
        for (const k of await db
          .selectFrom("knowledge")
          .select(["id", "source_key"])
          .where("project_id", "=", projectId)
          .where("source_key", "in", part)
          .execute())
          idOf.set(k.source_key, k.id);
  }
  const unlinked = self.size === 0 && prs.some((p) => p.merged && p.body);
  return { written, skipped, unlinked };
}
