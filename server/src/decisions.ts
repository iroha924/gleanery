// merge した PR の本文の「## 採った案と棄却した案」から、決まった書式の行だけを判断として取り出す。
// 生成 AI で読まない（API を持たない）。書式に合わない箇条書きは飛ばして数える（古い PR の自由な文は取り出さない）。
// 書式: `- 採った: <案>。棄却: <案>（<理由>）、<案>（<理由>）`。書き方の正本は .github/pull_request_template.md

import type { Kysely } from "kysely";
import { Lexer, type Tokens } from "marked";
import { iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { sha256 } from "./text.ts";

export type Rejected = { text: string; reason: string | null };
export type Extracted = { line: string; chosen: string; rejected: Rejected[] };

const SECTION = "採った案と棄却した案";
const CHOSEN = /^採った[:：]\s*(.*)$/;
const REJECTED = /^。\s*棄却[:：]\s*/;
const BARE_REJECTED = /棄却[:：]/;
const PAIRS: Record<string, string> = { "（": "）", "(": ")" };
const CLOSERS = new Set(Object.values(PAIRS));

/** インラインコード（`…`）の中を同じ長さの記号で埋める。括弧と区切りをコードの中で数えない。 */
const masked = (s: string): string => s.replace(/(`+)[\s\S]*?\1/g, (m) => "_".repeat(m.length));

/**
 * 括弧の外で sep の位置を返す。括弧は開きと閉じの種類を突き合わせる。釣り合わなければ null（書式に合わない）。
 * m はインラインコードを埋めた写しで、s と同じ長さ。
 */
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

/** 末尾の括弧（全角か半角）を理由として分ける。入れ子の括弧は理由の中に残す。空の案は null。 */
function withReason(item: string): Rejected | null {
  const s = item.trim().replace(/。$/, "");
  if (!s) return null;
  const m = masked(s);
  const close = m.at(-1) ?? "";
  if (!CLOSERS.has(close)) return { text: s, reason: null };
  let depth = 0;
  for (let i = m.length - 1; i >= 0; i--) {
    const c = m[i] ?? "";
    if (CLOSERS.has(c)) depth++;
    else if (c in PAIRS && --depth === 0) {
      if (PAIRS[c] !== close) return null;
      const text = s.slice(0, i).trim();
      return text ? { text, reason: s.slice(i + 1, -1).trim() || null } : null;
    }
  }
  return null;
}

/** 節の箇条書きの項目（1 行目）。見出し・コードブロック・HTML・リストの解釈は marked の lexer（CommonMark）に任せる。 */
function sectionItems(body: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const t of Lexer.lex(body)) {
    if (t.type === "heading") {
      if (inside && t.depth <= 2) break;
      inside = t.depth === 2 && t.text.trim() === SECTION;
      continue;
    }
    if (inside && t.type === "list")
      for (const item of (t as Tokens.List).items) out.push((item.text.split("\n")[0] ?? "").trim());
  }
  return out;
}

export function extractDecisions(body: string): { decisions: Extracted[]; skipped: number } {
  const decisions: Extracted[] = [];
  let skipped = 0;
  for (const line of sectionItems(body)) {
    const parsed = parse(line);
    if (parsed) decisions.push(parsed);
    else skipped++;
  }
  return { decisions, skipped };
}

/** `採った: <案>。棄却: <案>（<理由>）、…` の 1 行。形に合わなければ null。 */
function parse(line: string): Extracted | null {
  const rest = CHOSEN.exec(line)?.[1];
  if (rest === undefined) return null;
  const m = masked(rest);
  // 「棄却:」は括弧とコードの外で、句点の後ろにある最初のものだけで分ける
  const cut = outside(m, (i) => m[i] === "。" && REJECTED.test(m.slice(i)));
  if (!cut) return null;
  const at = cut[0];
  if (at === undefined) return BARE_REJECTED.test(m) ? null : chosenOnly(line, rest);
  const chosen = rest.slice(0, at).trim();
  const tail = rest.slice(at).replace(REJECTED, "");
  const tm = masked(tail);
  const commas = outside(tm, (i) => tm[i] === "、");
  if (!chosen || !commas) return null;
  const rejected = [...commas, tail.length].map((end, i, all) =>
    withReason(tail.slice(i ? (all[i - 1] ?? 0) + 1 : 0, end)),
  );
  if (rejected.some((r) => r === null)) return null;
  return { line, chosen, rejected: rejected as Rejected[] };
}

function chosenOnly(line: string, rest: string): Extracted | null {
  const chosen = rest.trim().replace(/。$/, "");
  return chosen ? { line, chosen, rejected: [] } : null;
}

/** 取り出し規則の版。書式や行の形を変えたら上げる（次の同期で全部の行の内容を書き直す。状態は保つ）。 */
const RULE = 1;

/** 判断を取り出す候補の PR。本文は message の external_id "body"、作者は GitHub の user id。 */
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
 * merge した持ち主の PR の本文から取り出した判断を、knowledge に揃える。db は同期の transaction の中の ingest の接続。
 * 既にある行の status と superseded_by_id は書き換えない（trace で覆した判断を再同期で戻さない）。
 * 残る行は更新し、消えた行（本文から消えた・持ち主でなくなった・merge が取り消された）だけ消す。
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
    // 判断が 1 つも取れない本文（古い PR の自由な文）は数えない。書式の打ち間違いだけを知らせる
    if (got.decisions.length) skipped += got.skipped;
    const heading = `PR #${pr.number}（${(pr.mergedAt ?? "").slice(0, 10)}）の判断`;
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

  // 消えた行を先に消す。PR から作った行は source_item と github: の key で見分ける（trace と文書の行に触らない）
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
      // status と superseded_by_id は書き換えない。内容の hash が変わった行だけを書く
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
    // 案は決定の id で結ぶ。書き直さなかった決定は returning に出ないので、key で引く
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
