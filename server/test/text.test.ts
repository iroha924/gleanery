import assert from "node:assert/strict";
import { test } from "node:test";
import { bytes, clean, ftsQuery, head, reason, tail, terms, uuidFrom } from "../src/text.ts";

// ひらがなだけの語（助詞・助動詞・「こと」）はどの行にも当たり、語彙側の順位を薄める。
test("語は日本語を語に割り、ひらがなだけの語を落とす", () => {
  const got = terms("私はなんて言ってた？埋め込みの再ランクを試した");
  for (const w of ["私", "埋", "込み", "再", "ランク"])
    assert.ok(got.includes(w), `${w} が無い: ${got.join(",")}`);
  for (const w of ["は", "なんて", "の", "を", "た", "め"]) assert.ok(!got.includes(w), `${w} が残っている`);
  // 取り込みと問い合わせで同じ語になる（片側だけ辞書が違うと当たらない）。
  assert.deepEqual(terms("埋め込み"), terms("埋め込みの"));
});

// Segmenter は `docs.ts` や `OT-123` を割ってしまう。ID を含む問いは丸ごとの一致でしか当たらない。
test("識別子は丸ごとも語になる", () => {
  const got = terms("server/src/db.ts の search_path と OT-123 と #27");
  for (const w of ["server/src/db.ts", "search_path", "ot-123", "#27"])
    assert.ok(got.includes(w), `${w} が無い: ${got.join(",")}`);
});

test("全角と大文字は揃える", () => {
  assert.deepEqual(terms("ＡＢＣ"), terms("abc"));
});

// 括らないと AND・NEAR・:・- が FTS5 の演算子として読まれ、利用者の文字列が問いの構文を変える。
test("FTS5 の問いは語を括り、中の引用符を二重にする", () => {
  assert.equal(ftsQuery("sql:live"), '"sql:live" OR "sql" OR "live"');
  for (const q of ['AND NEAR NOT x" -y *z', 'say "hi"', "col:1 (a) {b}"])
    for (const w of ftsQuery(q)?.split(" OR ") ?? []) assert.match(w, /^"(?:[^"]|"")+"$/, `${q}: ${w}`);
});

test("語の無い問いは引かない", () => {
  assert.equal(ftsQuery("のはを"), null);
  assert.equal(ftsQuery("   "), null);
});

// 同じ会話・同じ発言を 2 回送っても同じ行になることが、自動記録の送り直しの前提。
test("決定的な UUID は同じ部品から同じ値になり、version 8 の形をとる", () => {
  const a = uuidFrom("1", "claude-code", "session");
  assert.equal(a, uuidFrom("1", "claude-code", "session"));
  assert.notEqual(a, uuidFrom("1", "claude-code", "session2"));
  // 区切りが無いと ("ab","c") と ("a","bc") が同じになる。
  assert.notEqual(uuidFrom("ab", "c"), uuidFrom("a", "bc"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("バイトで切り、文字の途中で切らない", () => {
  const s = "あいう🙂えお";
  assert.equal(head(s, 4), "あ");
  assert.ok(bytes(head(s, 13)) <= 13);
  assert.equal(tail(s, 6), "えお");
  assert.equal(head("abc", 10), "abc");
});

test("NUL を落とす（SQLite の length・substr は NUL の後ろを読まない）", () => {
  assert.equal(clean(`a${String.fromCharCode(0)}b`), "ab");
});

test("例外の理由の文は、中のエラー（AggregateError の errors と cause）の理由も添える", () => {
  // pg は、複数のアドレスへの接続がすべて拒まれると理由の空の AggregateError を返す。
  const refused = new AggregateError([
    new Error("connect ECONNREFUSED ::1:1"),
    new Error("connect ECONNREFUSED 127.0.0.1:1"),
  ]);
  assert.equal(reason(refused), "connect ECONNREFUSED ::1:1 / connect ECONNREFUSED 127.0.0.1:1");
  // fetch は本当の理由を cause にだけ持つ。
  const fetchFailed = new Error("fetch failed", {
    cause: new Error("getaddrinfo ENOTFOUND api.voyageai.com"),
  });
  assert.equal(reason(fetchFailed), "fetch failed（getaddrinfo ENOTFOUND api.voyageai.com）");
  assert.equal(reason(new Error("鍵が無い")), "鍵が無い");
  assert.equal(reason(new Error("")), "理由の分からない失敗");
  // 理由の文が空なら種類の名前を理由にし、中のエラーのうち分かったものだけをつなぐ。
  const timeout = new Error("");
  timeout.name = "TimeoutError";
  assert.equal(reason(timeout), "TimeoutError");
  assert.equal(reason(new AggregateError([new Error(""), new Error("b")])), "b");
  assert.equal(reason(new AggregateError([], "", { cause: new Error("c") })), "c");
  assert.equal(reason(new AggregateError([])), "理由の分からない失敗");
  assert.equal(reason(Object.create(null)), "理由の分からない失敗");
  // 自分を cause に持つエラーでも止まる。
  const loop = new Error("a");
  loop.cause = loop;
  assert.equal(reason(loop), "a（a（a（a）））");
  assert.equal(reason("文字列"), "文字列");
});
