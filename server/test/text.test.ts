import assert from "node:assert/strict";
import { test } from "node:test";
import { bytes, clean, head, tail, terms, tsquery, tsvector, uuidFrom } from "../src/text.ts";

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

// 語に ' が入ると、組み立てたリテラルが壊れるか、別の語として解釈される。
test("tsvector と tsquery のリテラルは引用符を守る", () => {
  assert.match(tsvector("it's a test"), /'it''s'/);
  assert.match(tsquery("it's") ?? "", /^'it''s'/);
});

test("tsvector は位置を持ち、同じ語の位置は 256 個で止める", () => {
  const v = tsvector(Array.from({ length: 400 }, () => "設計").join(" "));
  const positions = v.match(/'設計':([\d,]+)/)?.[1]?.split(",") ?? [];
  assert.equal(positions.length, 256);
  assert.ok(Number(positions[0]) >= 1);
});

test("語の無い問いは語彙側を引かない", () => {
  assert.equal(tsquery("のはを"), null);
  assert.equal(tsquery("   "), null);
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

test("NUL を落とす（PostgreSQL の text は持てない）", () => {
  assert.equal(clean(`a${String.fromCharCode(0)}b`), "ab");
});
