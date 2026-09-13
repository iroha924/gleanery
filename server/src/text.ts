// 文字列の下ごしらえ。語の切り出し、全文索引のリテラル、ハッシュ、決定的な id、バイトでの切り詰め。
//
// **語は DB に切らせない。**PostgreSQL の text search は日本語を語に割れないので、
// 取り込み側と問い合わせ側の両方で同じ関数（terms）を通し、tsvector と tsquery をこちらで組む。
// 両側が同じ切り方なら、辞書の差で片側だけ語がずれることが起きない。

import crypto from "node:crypto";

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

// ひらがなだけの語は助詞・助動詞・「こと」「ため」の類で、どの行にも当たって順位を薄める。
const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u;
const STOP = new Set(["the", "a", "an", "of", "to", "in", "is", "and", "or", "for", "on", "it", "be"]);
// Segmenter が割ってしまう識別子（ファイル名、snake_case、OT-123、#27）は丸ごとも語にする。
const IDENT = /#\d+|[a-z0-9][a-z0-9_./#-]*[a-z0-9]/g;
// tsvector の語は 2 KB 未満。長すぎる塊は語ではない（base64 やハッシュ）。
const MAX_TERM = 100;

/** 検索に使う語を出現順に返す（重複を含む）。取り込みと問い合わせで同じものを使う。 */
export function terms(text: string): string[] {
  const norm = text.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  const keep = (w: string) => {
    if (w.length > MAX_TERM || STOP.has(w) || HIRAGANA_ONLY.test(w)) return;
    out.push(w);
  };
  for (const s of segmenter.segment(norm)) if (s.isWordLike) keep(s.segment.trim());
  for (const m of norm.matchAll(IDENT)) if (m[0].length >= 3) keep(m[0]);
  return out.filter(Boolean);
}

// tsvector と tsquery の入力では、語を ' で囲み、中の ' は二重に、\ は \\ にする。
const quote = (w: string): string => `'${w.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/**
 * tsvector のリテラル。位置を持たせる（ts_rank_cd は位置が無いと 0 を返す）。
 * PostgreSQL は 1 語あたり位置 256 個まで、位置の値 16,383 までしか持てないので、そこで止める。
 */
export function tsvector(text: string): string {
  const pos = new Map<string, number[]>();
  terms(text).forEach((w, i) => {
    const p = pos.get(w) ?? [];
    if (p.length < 256) p.push(Math.min(i + 1, 16_383));
    pos.set(w, p);
  });
  return [...pos].map(([w, p]) => `${quote(w)}:${[...new Set(p)].join(",")}`).join(" ");
}

/** 問いの語のどれかに当たる tsquery。語が無ければ null（語彙側を引かない）。 */
export function tsquery(question: string): string | null {
  const ws = [...new Set(terms(question))].slice(0, 16);
  return ws.length ? ws.map(quote).join(" | ") : null;
}

export const sha256 = (s: string): Buffer => crypto.createHash("sha256").update(s).digest();

/**
 * 部品から決定的に作る UUID（RFC 9562 の version 8）。同じ会話・同じ発言を 2 回送っても同じ id になるので、
 * 取り込みと自動記録の再送が `on conflict do nothing` だけで冪等になる。
 */
export function uuidFrom(...parts: string[]): string {
  const b = crypto.createHash("sha256").update(parts.join("\u0000")).digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** n バイト以内に先頭から詰める。文字の途中で切らない。 */
export function head(s: string, n: number): string {
  if (bytes(s) <= n) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (used + b > n) break;
    out += ch;
    used += b;
  }
  return out;
}

/** n バイト以内に末尾から詰める。 */
export function tail(s: string, n: number): string {
  if (bytes(s) <= n) return s;
  const chars = [...s];
  let used = 0;
  let i = chars.length;
  while (i > 0) {
    const b = bytes(chars[i - 1] ?? "");
    if (used + b > n) break;
    used += b;
    i--;
  }
  return chars.slice(i).join("");
}

/** PostgreSQL の text は NUL を持てない。外から来た文字列は入れる前にここを通す。 */
export const clean = (s: string): string => s.replaceAll("\u0000", "");
