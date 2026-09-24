// merge した PR の本文の「## 採った案と棄却した案」から、決まった書式の行だけを判断として取り出す。
// 生成 AI で読まない（API を持たない）。書式に合わない箇条書きは飛ばして数える（古い PR の自由な文は取り出さない）。
// 書式: `- 採った: <案>。棄却: <案>（<理由>）、<案>（<理由>）`。書き方の正本は .github/pull_request_template.md

import type { Kysely } from "kysely";
import { iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { sha256 } from "./text.ts";

export type Rejected = { text: string; reason: string | null };
export type Extracted = { line: string; chosen: string; rejected: Rejected[] };

const SECTION = /^##\s*採った案と棄却した案\s*$/;
const HEADING = /^#{1,2}\s/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const ITEM = /^\s*[-*]\s+/;
const CHOSEN = /^\s*[-*]\s+採った[:：]\s*(.*)$/;
// 分けるのは句点の後ろの「棄却:」だけ（採った案の中に「棄却:」と書いても分けない）
const REJECTED = /。\s*棄却[:：]\s*/;
const BARE_REJECTED = /棄却[:：]/;

/** 括弧（全角・半角）の外にある sep で分ける。括弧が閉じていなければ null（書式に合わない）。 */
function splitOutside(s: string, sep: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "（" || c === "(") depth++;
    else if (c === "）" || c === ")") {
      if (depth === 0) return null;
      depth--;
    } else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  out.push(s.slice(start));
  return out;
}

/** 末尾の括弧（全角か半角）を理由として分ける。入れ子の括弧は理由の中に残す。空の案は null。 */
function withReason(item: string): Rejected | null {
  const s = item.trim().replace(/。$/, "");
  if (!s) return null;
  const close = s.at(-1);
  const open = close === "）" ? "（" : close === ")" ? "(" : null;
  if (!open) return { text: s, reason: null };
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === close) depth++;
    else if (s[i] === open && --depth === 0) {
      const text = s.slice(0, i).trim();
      return text ? { text, reason: s.slice(i + 1, -1).trim() || null } : null;
    }
  }
  return null;
}

/** 節の中の行。HTML のコメント（閉じていなければ最後まで）とコードブロックの中は、節の見出しも含めて読まない。 */
function sectionLines(body: string): string[] {
  let text = body.replace(/<!--[\s\S]*?-->/g, "");
  const unclosed = text.indexOf("<!--");
  if (unclosed >= 0) text = text.slice(0, unclosed);
  const out: string[] = [];
  let fence: string | null = null;
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const f = FENCE.exec(line)?.[1];
    if (f) {
      // 閉じるのは開いたときと同じ記号で、同じ長さ以上のものだけ
      if (fence === null) fence = f;
      else if (f[0] === fence[0] && f.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (!inside) {
      inside = SECTION.test(line);
      continue;
    }
    if (HEADING.test(line)) break;
    out.push(line);
  }
  return out;
}

export function extractDecisions(body: string): { decisions: Extracted[]; skipped: number } {
  const decisions: Extracted[] = [];
  let skipped = 0;
  for (const line of sectionLines(body)) {
    if (!ITEM.test(line)) continue;
    const rest = CHOSEN.exec(line)?.[1];
    const at = rest === undefined ? null : REJECTED.exec(rest);
    // 句点の無い「棄却:」は分け方が決まらないので、行ごと飛ばす
    if (rest === undefined || (!at && BARE_REJECTED.test(rest))) {
      skipped++;
      continue;
    }
    const chosen = (at ? rest.slice(0, at.index) : rest).trim().replace(/。$/, "");
    const parts = at ? splitOutside(rest.slice(at.index + at[0].length), "、") : [];
    const rejected = parts?.map(withReason) ?? null;
    if (!chosen || !rejected || rejected.some((r) => r === null) || (at && rejected.length === 0)) {
      skipped++;
      continue;
    }
    decisions.push({ line: line.trim(), chosen, rejected: rejected as Rejected[] });
  }
  return { decisions, skipped };
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
    skipped += got.skipped;
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
