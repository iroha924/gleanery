// 材料にあったのに記録へ入らなかったものを、**決定論的な突き合わせだけ**で探す。
//
// なぜ意味を理解する検査を入れないか。
//   - 脱落検出の実測上限は F1 41〜51%（OLDS, arXiv 2211.07145。専用に学習したモデルでの数字）
//   - 会議要約では、脱落との相関は n-gram (ROUGE-1 -0.40) が意味ベース (BERTScore -0.16) を上回る
//     （arXiv 2404.11124）。「意味が分かる指標のほうが漏れを捉えるはず」は実測で否定されている
//   - LLM に判定させると相関 .17 で古典的指標より悪い（AutoMin 3, arXiv 2509.13814）
//   - 意味ベースの指標は「無害な文を足すと点が上がる」形で壊せる（arXiv 2411.16638）。
//     生成も検査も AI が担うこの設計では、その経路が現実に開く
//
// なぜ識別子なら成立するか。recall を測るには「入るべきだった情報の完全な集合」が要る
// （Precision Is Not Faithfulness, arXiv 2606.09376）。会話全体にそれは無いが、
// **実行したコマンド・変更したファイル・起動したサブエージェント・参照した URL・人が選んだ選択**は
// 有限に列挙できるので、部分的な完全集合として使える。
//
// 日付・時刻・数値は突き合わせない。表現の揺れが大きくマッチ判定が破綻する
// （Entity-level Factual Consistency, EACL 2021 の脚注 2 が同じ理由で除外している）。

// 記録に書く価値の無い変更。除外しないと毎回同じ警告が出て、読まれなくなる。
const NOISE = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.venv|vendor)\/|(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$|\.(min\.(js|css)|snap|lock)$/;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// 「明示起動だけ（推奨）」のような装飾を落とす。付いたまま照合すると、
// 記録側が本文へ自然に書いた「明示起動だけ」に当たらず、偽陽性になる。
const key = (s) => norm(s).replace(/[（(].*?[)）]/g, '').replace(/[、。「」]/g, '').trim();

// 記録が指している参照先が実在するか。**存在しないコミットやファイルを証拠に書く**のは
// 実在する幻覚経路で、構造の検査も網羅の検査も見ていない（どちらも「証拠が付いているか」までしか見ない）。
// チェックリスト設計の基準「他の仕組みで十分に検査されていないか」に、ここだけが当たる。
// URL と issue は網越しなので見ない。ゲートがネットワークに依存すると、落ちたときに止まる。
export function refsExist(ir, repoRoot, run) {
  const bad = [];
  const seen = new Set();
  for (const [where, list] of [
    ...(ir.decisions || []).map((d) => [`decisions ${d.id}`, d.evidence]),
    ...(ir.events || []).map((e) => [`events ${e.id}`, e.evidence]),
    ...(ir.verification || []).map((v) => [`verification ${v.id}`, v.evidence]),
  ]) {
    for (const e of list || []) {
      const k = `${e.kind}:${e.ref}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (e.kind === 'commit') {
        if (!run.commitExists(e.ref)) bad.push({ where, kind: 'commit', ref: e.ref });
      } else if (e.kind === 'file') {
        const p = String(e.ref).split(':')[0];  // path:line の行番号を落とす
        if (!run.fileExists(p)) bad.push({ where, kind: 'file', ref: p });
      }
    }
  }
  return bad;
}

export function cover(digest, ir) {
  const blob = JSON.stringify(ir);
  // **正規化は両側に当てる。**針だけ `key()` を通して記録側を生のまま照合すると、
  // 句読点や鉤括弧が 1 つ入っただけで当たらない（実測: 回答「生きている。進めて良い」を
  // そのまま書いた記録が、針「生きている進めて」に当たらず未記録と報告された）。
  // 記録側を歪めて針に合わせることになるので、片側だけの正規化は誤りである。
  const keyed = key(blob);
  const hit = (s) => Boolean(s) && (blob.includes(s) || keyed.includes(s));
  const groups = [];

  // 人が選んだ決定。**これだけは落としてはいけない**ので、唯一の違反にする。
  // 選択肢とトレードオフを見せたうえで人が選んだ記録は、他のどこにも復元できない。
  const choices = digest.choices || [];
  const choiceMiss = choices.filter((c) => {
    // 回答は複数選択のことがあるので、どれか 1 つでも記録に出ていれば入っているとみなす。
    const answers = key(c.answer).split(',').map((x) => x.trim()).filter(Boolean);
    return !hit(key(c.question).slice(0, 14)) && !answers.some((a) => hit(a.slice(0, 8)));
  });
  groups.push({
    id: 'choices', label: '人が選んだ決定（AskUserQuestion）', blocking: true,
    total: choices.length, missing: choiceMiss.map((c) => `${norm(c.question).slice(0, 46)} → ${norm(c.answer) || '(未取得)'}`),
    fix: 'decisions へ移す。問いを context に、選択肢と説明を options に、回答を chosen にする',
  });

  const files = (digest.git?.changed || []).map((c) => c.path).filter((p) => !NOISE.test(p));
  groups.push({
    id: 'files', label: '変更したファイル', blocking: false,
    total: files.length, missing: files.filter((p) => !hit(p) && !hit(p.replace(/\/[^/]*$/, ''))),
    fix: 'links.files に入れるか、その変更に対応する events を書く',
  });

  // サブエージェントは件数だけ見る。ツールに渡した説明は内部のラベルで、
  // 記録側が自然に書く言葉とは一致しない。文字列で個別に突き合わせると偽陽性しか出ない。

  const urls = digest.urls || [];
  groups.push({
    id: 'urls', label: '参照した URL', blocking: false,
    total: urls.length, missing: urls.filter((u) => !hit(u.slice(0, 40))),
    fix: '一次ソースとして使ったなら evidence へ。使わなかったなら記録しなくてよい',
  });

  // 失敗したコマンドは個別に突き合わせない。一時的な打ち間違いと、方針が駄目だったことは
  // 機械では区別できず、個別に指摘すると偽陽性ばかりになる（Tricorder の EFP < 10% 基準）。
  // 件数だけを並べ、判断は書き手に返す。
  // 個別に突き合わせず件数だけを出すもの。判断は書き手へ返す。
  const failed = (digest.failedCommands || []).length;
  const deadEnds = (ir.events || []).filter((e) => e.kind === 'dead_end').length;
  const agents = (digest.agents || []).length;
  const notes = [];
  if (failed > 0 && deadEnds === 0) notes.push(`失敗したコマンドが ${failed} 件あるが、駄目だった道の記録が 0 件。打ち間違いだけなら問題ない`);
  if (agents > 0) notes.push(`サブエージェントを ${agents} 体起動している。何を調べさせ何が分かったかが記録に要るか確かめる`);
  const note = notes.length ? notes.join(' / ') : null;

  const blocked = groups.filter((g) => g.blocking && g.missing.length > 0);
  const warned = groups.filter((g) => !g.blocking && g.missing.length > 0);
  return { groups, note, ok: blocked.length === 0, blocked, warned, failedCommands: failed, deadEnds };
}
