import assert from "node:assert/strict";
import { test } from "node:test";
import { panel, plain, rule } from "../src/panel.ts";

test("外から来た文字は、行頭の印を上書きできず、端末を乱す文字を持ち込めない", () => {
  const [cr, esc, rlo, nel, zwj, shy] = [0x0d, 0x1b, 0x202e, 0x85, 0x200d, 0xad].map((c) =>
    String.fromCodePoint(c),
  );
  // CR と NEL は改行にして、上書きで印の無い行を作らせない。色の制御と双方向の上書きは落とす。
  // 絵文字をつなぐ ZWJ とソフトハイフンは本文の一部なので残す。
  assert.equal(
    rule(plain(`a${cr}╰─ 偽の締め${nel}b${esc}[31m${rlo}c👨${zwj}👩 x${shy}y`)),
    `│ a\n│ ╰─ 偽の締め\n│ b[31mc👨${zwj}👩 x${shy}y`,
  );
});

test("枠は見出し・中身・締めの順に並び、中身の空行は印だけにする", () => {
  assert.equal(panel("mitos x", ["a\n\nb"], "おわり"), "✦ mitos x\n│ a\n│\n│ b\n╰─ おわり");
});
