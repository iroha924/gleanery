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

// 貼ってしまった鍵を DB・待ち行列・埋め込みの API へ入れない。**伏せるのは形で分かるものだけ**（推測で文を消さない）。
// 形は 5 つ: 接頭辞の決まった鍵、鍵の名前への代入（KEY=… / "password": "…"）、URL に埋めた資格情報、認証ヘッダの値、
// `mysql -p` のパスワード。載っていない形式の鍵は伏せられない。貼らないのが先で、これは取りこぼしを減らす網である。
// **どれも入力の長さに対して線形で終わる形に保つ。**フックは 128 KiB までの発言を、trace は上限の無い本文を通す。
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "秘密鍵"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "API キー"],
  [/\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "API キー"],
  [/\bwhsec_[A-Za-z0-9+/=]{16,}/g, "Webhook の署名鍵"],
  [/\bpa-[A-Za-z0-9_-]{20,}/g, "API キー"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "API キー"],
  [/\bnpg_[A-Za-z0-9]{12,}/g, "DB のパスワード"],
  [/\bnapi_[A-Za-z0-9]{30,}/g, "API キー"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "npm のトークン"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "GitLab のトークン"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "GitHub トークン"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "GitHub トークン"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack トークン"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "Slack の Webhook"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS のキー"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "JWT"],
  // ヘッダの外に貼った値。大文字の Bearer と数字を含む値だけ（「refresh token <パス>」を消さない）。
  [/\bBearer\s+(?=[A-Za-z0-9._~+/=-]{0,512}\d)[A-Za-z0-9._~+/=-]{16,}/g, "認証ヘッダの値"],
];
const AUTH_HEADER = /(\bAuthorization\s*:\s*(?:Bearer|Basic|Token|Digest)\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// 環境変数の形（大文字の名前への代入）。**値が変数の参照なら伏せない**（`PASSWORD=$DB_PASSWORD`）。
// KEY は単独か、語の区切り（`_`）か鍵の語（MASTERKEY）の後だけ。PASS・PWD は `_` の後だけ
// （MONKEY=banana、COMPASS=north と、シェルの作業ディレクトリ PWD=/Users/… を消さない）。
const ENV_ASSIGN =
  /\b((?:[A-Z][A-Z0-9_]*_)?(?:API|SECRET|MASTER|ENCRYPTION|PRIVATE|ACCESS|SIGNING|AUTH)?KEY|[A-Z][A-Z0-9_]*_(?:PASS|PWD)|(?:[A-Z][A-Z0-9_]*?)?(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))(\s*=\s*)(?:"(?!\$)[^"\n]+"|'(?!\$)[^'\n]+'|(?![$"'])[^\s"']+)/g;
// 設定ファイル・JSON・ヘッダの形（名前が鍵の語で終わる）。照合は鍵の語から始め、名前の前半は見ない。
// 値が鍵らしいかは関数で決める（正規表現の先読みで決めると、繰り返した入力で照合が二乗に伸びる）。
const FIELD_ASSIGN =
  /((?:api|account|access|private|secret)[-_]?key|secret|token|passw(?:or)?d)(["']?\s*[:=]\s*)(["']?)([^\s"',;]+)/gi;
// 引用符で囲んだ値は 8 文字以上なら鍵とみなす。囲まない値は、数字と英字を両方含む 8 文字以上だけ
// （コードの `token = getToken()`、型注釈の `password: string`、CSS の `--brand-token: #ff00aa` を消さない）。
const secretValue = (quoted: boolean, v: string): boolean =>
  v.length >= 8 && !/^[$#]/.test(v) && (quoted || (/\d/.test(v) && /[A-Za-z]/.test(v) && !/[()]/.test(v)));
// `mysql -p<パスワード>`（-p の直後に空白を置かない形だけがパスワードを持つ）。探す幅を 1 行 200 字に切って線形に保つ。
const MYSQL_PASSWORD = /(\bmysql(?:dump|admin)?\b[^\n]{0,200}?\s-p)(?=[^\s-])\S+/g;
// URL の資格情報は、パスワードに @ を含んでも host の直前の @ まで伏せる。どこへ繋いだかは話の中身として残す。
// userinfo は最初の `/` より前にしか無い（`http://localhost:5173/@vite` のポートを伏せない）。ここで切ると線形で終わる。
const URL_CREDENTIALS =
  /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|https?):\/\/[^:\s/@]*:)[^\s/]*@([^@\s/?#]+)/g;

export function mask(text: string): string {
  // 代入・ヘッダ・URL を先に伏せる（値ごと消える）。残った裸の鍵を形で伏せる。
  let out = text
    .replace(URL_CREDENTIALS, "$1[伏せた]@$2")
    .replace(AUTH_HEADER, "$1[伏せた]")
    .replace(ENV_ASSIGN, "$1$2[伏せた]")
    .replace(FIELD_ASSIGN, (all, name: string, sep: string, quote: string, value: string) =>
      secretValue(quote !== "", value) ? `${name}${sep}${quote}[伏せた]` : all,
    )
    .replace(MYSQL_PASSWORD, "$1[伏せた]");
  for (const [re, what] of SECRETS) out = out.replace(re, `[伏せた: ${what}]`);
  return out;
}
