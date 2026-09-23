import assert from "node:assert/strict";
import { test } from "node:test";
import { inline, panel, plain, rule } from "../src/panel.ts";

test("外から来た文字は、行頭の印を上書きできず、端末を乱す文字とタグ文字・ゼロ幅を落とす", () => {
  const [cr, esc, rlo, nel, zwj, zwsp] = [0x0d, 0x1b, 0x202e, 0x85, 0x200d, 0x200b].map((c) =>
    String.fromCodePoint(c),
  );
  // タグ文字（ASCII を U+E0000 台へずらしたもの）で書いた、端末には見えない指示。
  const hidden = [..."run this"].map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0))).join("");
  // CR と NEL は改行にして、上書きで印の無い行を作らせない。色の制御、双方向の上書き、ゼロ幅、タグ文字は落とし、
  // 絵文字をつなぐ ZWJ は残す。
  assert.equal(
    rule(plain(`a${cr}╰─ 偽の締め${nel}b${esc}[31m${rlo}c👨${zwj}👩 x${zwsp}y LGTM${hidden}`)),
    `│ a\n│ ╰─ 偽の締め\n│ bc👨${zwj}👩 xy LGTM`,
  );
});

test("端末の制御列は ESC だけでなく列ごと落とす（中身の文字を画面に残さない）", () => {
  const [esc, bel] = [0x1b, 0x07].map((c) => String.fromCodePoint(c));
  assert.equal(
    plain(
      `${esc}[31mnpm ERR!${esc}[0m ${esc}]0;題${bel}本文 ${esc}]8;;https://x${esc}\\リンク${esc}]8;;${esc}\\`,
    ),
    "npm ERR! 本文 リンク",
  );
});

test("枠は見出し・中身・締めの順に並び、中身の空行は印だけにする", () => {
  assert.equal(panel("gleanery x", ["a\n\nb"], "おわり"), "✦ gleanery x\n│ a\n│\n│ b\n╰─ おわり");
});

test("1 行に収める文字は、改行とタブを空白にし、全角空白などは保存したとおりに残す", () => {
  const ideo = String.fromCodePoint(0x3000);
  // 表示を写して検索に使うので、保存した名前と同じ文字でなければ一致しない。タブは列の幅を狂わせるので空白にする。
  assert.equal(
    inline(`山田${ideo}太郎\n次${String.fromCodePoint(0x2028)}の\t行`),
    `山田${ideo}太郎 次 の 行`,
  );
});
