#!/usr/bin/env node
// 仕込んだ欠陥を validate() が拾えるかを測る。加えて、採掘が人の発話を落とさないことと、
// 網羅の検査が材料の取りこぼしを拾えることを見る。
//
// **描画に関する検査は d-drop-record-files で消した。**HTML と Markdown を出さなくなり、
// XSS の境界・往復の一致・要約・折りたたみは、対象そのものが無くなった。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/ir.mjs';
import { collect } from '../lib/collect.mjs';
import { cover, refsExist } from '../lib/cover.mjs';
import { applyPatch } from '../lib/patch.mjs';
import { sessionRecordId, sessionize } from '../lib/session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
let pass = 0, fail = 0;
const ng = (id, msg) => { console.error(`  NG ${id}: ${msg}`); fail++; };
const ok = (id) => { console.log(`  ok ${id}`); pass++; };

for (const c of cases) {
  const ir = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', `${c.id}.json`), 'utf8'));
  const r = validate(ir);
  const exit = r.ok ? 0 : 1;
  const codes = [...r.problems, ...r.warnings].map((p) => p.code);
  if (exit !== c.expect_exit) { ng(c.id, `終了コードが ${exit}、期待は ${c.expect_exit}（${codes.join(', ') || 'なし'}）`); continue; }
  if (c.expect_code && !codes.includes(c.expect_code)) { ng(c.id, `${c.expect_code} が出ていない（出たのは ${codes.join(', ') || 'なし'}）`); continue; }
  if (c.expect_warnings !== undefined && r.warnings.length !== c.expect_warnings) { ng(c.id, `警告が ${r.warnings.length} 件、期待は ${c.expect_warnings}（${r.warnings.map((w) => w.code).join(', ')}）`); continue; }
  ok(c.id);
}
console.log('参照と検証の接続:');
{
  const base = () => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  let x = base(); x.decisions[1].supersededBy = 'other-record#d-foo';
  if (validate(x).ok) ok('ref-cross-record'); else ng('ref-cross-record', '記録をまたぐ参照が通らない');
  x = base(); x.decisions[1].supersededBy = 'd-nope';
  if (validate(x).problems.some((p) => p.code === 'decisions/superseded-by-missing')) ok('ref-dangling-detected');
  else ng('ref-dangling-detected', '壊れた記録内参照を拾えていない');
  x = base(); x.verification[0].verifies = 'd-missing';
  if (validate(x).problems.some((p) => p.code === 'verification/verifies-missing')) ok('verifies-dangling-detected');
  else ng('verifies-dangling-detected', '壊れた verifies を拾えていない');
  // 結び付けを外すと警告が出て、戻すと消える。両方向を見ないと、
  // 「いつも出ない」検査と「いつも出る」検査のどちらも見逃す。
  x = base();
  for (const v of x.verification) delete v.verifies;
  if (validate(x).warnings.some((w) => w.code === 'decisions/unverified')) ok('unverified-warned');
  else ng('unverified-warned', '結び付けが無いのに警告が出ない');
  if (!validate(base()).warnings.some((w) => w.code === 'decisions/unverified')) ok('unverified-clears');
  else ng('unverified-clears', '結び付けたのに警告が残る');
}

// patch: 契約を当てる側で拒否できること。**散文で書いてあるだけの規約は守られなかった**ので、
// 「追記だけ」「id は再利用しない」「履歴を上書きしない」をここで機構にしてある。
console.log('patch:');
{
  const base = () => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  const el = (id) => ({ id, at: '2026-09-09T00:00:00+09:00', kind: 'finding', text: 'x' });

  let r = applyPatch(base(), { append: { events: [el('e-brand-new')] } });
  if (r.ok && r.ir.events.length === base().events.length + 1) ok('patch-append');
  else ng('patch-append', `追記できていない: ${JSON.stringify(r.problems)}`);

  // 既にある id への追記は、過去の要素を黙って書き換える道になる
  const existing = base().events[0].id;
  r = applyPatch(base(), { append: { events: [{ ...el(existing) }] } });
  if (r.problems.some((p) => p.code === 'patch/append-duplicate-id')) ok('patch-duplicate-id');
  else ng('patch-duplicate-id', 'id の再利用を拒否できていない');

  r = applyPatch(base(), { append: { events: [{ id: 'e-no-at', kind: 'finding', text: 'x' }] } });
  if (r.problems.some((p) => p.code === 'patch/append-no-at')) ok('patch-no-at');
  else ng('patch-no-at', '観測時点の無い要素を通してしまう');

  // events を set できると追記だけの契約が消える
  r = applyPatch(base(), { set: { events: [] } });
  if (r.problems.some((p) => p.code === 'patch/not-settable')) ok('patch-not-settable');
  else ng('patch-not-settable', '過去の要素を上書きできてしまう');

  r = applyPatch(base(), { set: { meta: { id: 'other' } } });
  if (r.problems.some((p) => p.code === 'patch/meta-locked')) ok('patch-meta-locked');
  else ng('patch-meta-locked', 'meta.id を書き換えられてしまう');

  const b = base();
  r = applyPatch(b, { supersede: { [b.decisions[0].id]: b.decisions[1].id } });
  const t = r.ir.decisions.find((d) => d.id === b.decisions[0].id);
  if (r.ok && t.status === 'superseded' && t.supersededBy === b.decisions[1].id) ok('patch-supersede');
  else ng('patch-supersede', `覆した印が付いていない: ${JSON.stringify(r.problems)}`);

  r = applyPatch(base(), { supersede: { 'd-nope': base().decisions[0].id } });
  if (r.problems.some((p) => p.code === 'patch/supersede-missing')) ok('patch-supersede-missing');
  else ng('patch-supersede-missing', '存在しない決定を覆せてしまう');

  // **append と set が同じ欄に来ると、set が丸ごと置き換えて append が消える。**
  // しかも「当てた」と報告される — このコマンドが無くすために作られた失敗の形そのもの。
  r = applyPatch(base(), { append: { openQuestions: [{ id: 'q-x', at: '2026-01-01' }] }, set: { openQuestions: [] } });
  if (r.problems.some((p) => p.code === 'patch/append-and-set')) ok('patch-append-and-set');
  else ng('patch-append-and-set', 'append が黙って捨てられる');

  // 自分で自分を覆すと、何にも置き換わっていないのに status だけ superseded になる
  r = applyPatch(base(), { supersede: { [base().decisions[0].id]: base().decisions[0].id } });
  if (r.problems.some((p) => p.code === 'patch/supersede-self')) ok('patch-supersede-self');
  else ng('patch-supersede-self', '自分自身を覆せてしまう');

  // 現在地が消えた記録は current_work から見えなくなる
  r = applyPatch(base(), { set: { current: null } });
  if (r.problems.some((p) => p.code === 'patch/set-empty')) ok('patch-set-empty');
  else ng('patch-set-empty', '空の値を書き込んでしまう');

  r = applyPatch(base(), { set: { next: {} } });
  if (r.problems.some((p) => p.code === 'patch/set-not-array')) ok('patch-set-shape');
  else ng('patch-set-shape', '配列でない next を通してしまう');

  r = applyPatch(base(), { set: { knowledge: [base().decisions[0].id] } });
  if (r.ok && r.ir.knowledge[0] === base().decisions[0].id) ok('patch-set-knowledge');
  else ng('patch-set-knowledge', `検索対象を更新できない: ${JSON.stringify(r.problems)}`);

  r = applyPatch(base(), { set: { knowledge: {} } });
  if (r.problems.some((p) => p.code === 'patch/set-not-array')) ok('patch-set-knowledge-shape');
  else ng('patch-set-knowledge-shape', '配列でない knowledge を通してしまう');

  r = applyPatch(base(), { nope: {} });
  if (r.problems.some((p) => p.code === 'patch/unknown-key')) ok('patch-unknown-key');
  else ng('patch-unknown-key', '知らない欄が黙って捨てられる');

  // **違反があったら元の IR を変えない。**半分だけ当たると何が入ったか判定できない
  const before = base();
  r = applyPatch(before, { append: { events: [el('e-ok')] }, set: { decisions: [] } });
  if (!r.ok && before.events.length === base().events.length) ok('patch-no-mutation');
  else ng('patch-no-mutation', '渡した IR を壊している');
}

console.log('採掘:');
{
  const d = collect(path.join(HERE, 'fixtures', 'transcript.claude.jsonl'), 'claude-code', '/tmp');
  const texts = d.userMessages.map((u) => u.text);
  if (texts.length === 2) ok('collect-user-count'); else ng('collect-user-count', `人の発話が ${texts.length} 件（期待 2）: ${texts.map((t) => t.slice(0, 20))}`);
  if (texts.some((t) => t.startsWith('ターン中に送った指示'))) ok('collect-midturn'); else ng('collect-midturn', 'ターン中の発言が落ちている');
  if (!texts.some((t) => t.startsWith('Another Claude') || t.startsWith('<task-notification') || t.startsWith('Base directory'))) ok('collect-notifications-excluded');
  else ng('collect-notifications-excluded', '通知が人の発話に混ざっている');
  if (d.notifications === 4) ok('collect-notification-count'); else ng('collect-notification-count', `通知が ${d.notifications} 件（期待 4）`);
  // compact 要約は人の発言ではない。混ざると「ユーザーがこう言った」という嘘になる。
  if (!texts.some((t) => t.startsWith('This session is being continued'))) ok('collect-compact-excluded');
  else ng('collect-compact-excluded', 'compact 要約が人の発話に混ざっている');
  if (d.compactions === 1) ok('collect-compaction-count'); else ng('collect-compaction-count', `compact 回数が ${d.compactions}（期待 1）`);
  // AskUserQuestion は「選択肢とトレードオフを見せて人が選んだ」記録。落とすと、
  // このスキルが最も欲しい形の意思決定が丸ごと消える（実測: 3 件が記録に入らなかった）。
  if (d.choices.length === 1) ok('collect-choice'); else ng('collect-choice', `選択が ${d.choices.length} 件（期待 1）`);
  const c0 = d.choices[0] || {};
  if ((c0.options || []).length === 2 && c0.options[0].why) ok('collect-choice-options');
  else ng('collect-choice-options', '選択肢とその理由が取れていない');
  if (c0.answer === 'ルート直下') ok('collect-choice-answer'); else ng('collect-choice-answer', `回答が ${JSON.stringify(c0.answer)}`);
  if (d.failedCommands.length === 1 && d.failedCommands[0].exit === 1) ok('collect-failed-exit'); else ng('collect-failed-exit', `失敗コマンドの取り方が違う: ${JSON.stringify(d.failedCommands)}`);
  if (d.commands.length === 2) ok('collect-command-count'); else ng('collect-command-count', `コマンドが ${d.commands.length} 件（期待 2）`);
  if (d.messages.some((m) => m.role === 'ai' && m.text.includes('実装を完了'))) ok('collect-assistant');
  else ng('collect-assistant', 'AI の応答が会話から落ちている');

  const ir = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  const attached = sessionize(d, ir);
  if (attached.meta.id === sessionRecordId('claude-code', 's1') && attached.schema === 'session/3') ok('sessionize-identity');
  else ng('sessionize-identity', `セッションの識別が違う: ${attached.meta.id}`);
  if (attached.utterances.length === d.messages.length && validate(attached).ok) ok('sessionize-valid');
  else ng('sessionize-valid', `会話を結び付けた IR が不正: ${JSON.stringify(validate(attached).problems)}`);

  const withoutKnowledge = structuredClone(attached);
  delete withoutKnowledge.knowledge;
  if (validate(withoutKnowledge).problems.some((p) => p.code === 'knowledge/required')) ok('knowledge-required');
  else ng('knowledge-required', '新しいセッション記録で検索対象を省略できてしまう');

  const missingKnowledge = structuredClone(attached);
  missingKnowledge.knowledge = ['d-does-not-exist'];
  if (validate(missingKnowledge).problems.some((p) => p.code === 'knowledge/missing')) ok('knowledge-reference');
  else ng('knowledge-reference', '存在しない要素を検索対象にできてしまう');

  const duplicateKnowledge = structuredClone(attached);
  duplicateKnowledge.knowledge = [attached.decisions[0].id, attached.decisions[0].id];
  if (validate(duplicateKnowledge).problems.some((p) => p.code === 'knowledge/duplicate')) ok('knowledge-duplicate');
  else ng('knowledge-duplicate', '同じ検索対象を重複指定できてしまう');
}

// 網羅: 材料にあったのに記録へ入らなかったものを、識別子の突き合わせだけで拾えること。
// 意味を理解する検査は入れない（実測 F1 41〜51%、LLM 判定は相関 .17）。
console.log('網羅:');
{
  const dg = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'digest.json'), 'utf8'));
  const irc = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  const r = cover(dg, irc);
  const g = (id) => r.groups.find((x) => x.id === id);
  // 人が選んだ決定は 1 件も入っていないので、必ず違反になる
  if (!r.ok && g('choices').missing.length === 2) ok('cover-choices-blocking');
  else ng('cover-choices-blocking', `選択の未記録が ${g('choices').missing.length} 件、ok=${r.ok}`);
  // node_modules は除外される。しないと毎回同じ警告が出て読まれなくなる
  if (g('files').missing.length === 1 && g('files').missing[0].includes('pdf_uploader')) ok('cover-noise-excluded');
  else ng('cover-noise-excluded', `変更ファイルの未記録: ${JSON.stringify(g('files').missing)}`);
  // 記録に入っているものは検出しない（偽陽性を出さない）
  const irOk = JSON.parse(JSON.stringify(irc));
  irOk.decisions[0].context += ' 保存先をどこにしますか / 名前をどうしますか';
  irOk.links.files.push('app/services/pdf_uploader.rb');
  irOk.events[0].text += ' 調査エージェント https://example.com/spec を使った';
  const r2 = cover(dg, irOk);
  if (r2.ok) ok('cover-no-false-positive'); else ng('cover-no-false-positive', `入っているのに未記録と判定: ${JSON.stringify(r2.blocked)}`);
  if (r2.warned.length === 0) ok('cover-warnings-clear'); else ng('cover-warnings-clear', `警告が残る: ${r2.warned.map((w) => w.id)}`);
  // 参照先の実在。存在しないコミットやファイルを証拠に書く経路を塞ぐ。
  // どれも実在しない世界。commit と file の両方を拾えること（command / url / issue は見ない）
  const none = { commitExists: () => false, fileExists: () => false };
  const badRefs = refsExist(irc, '/tmp', none);
  const kinds = new Set(badRefs.map((b) => b.kind));
  if (kinds.has('commit') && kinds.has('file')) ok('refs-detect-missing');
  else ng('refs-detect-missing', `拾えた種類: ${[...kinds].join(',') || 'なし'}（commit と file の両方が要る）`);
  if (!badRefs.some((b) => ['command', 'url', 'issue'].includes(b.kind))) ok('refs-skip-network');
  else ng('refs-skip-network', '網越しの参照を検査対象にしている');
  const allOk = { commitExists: () => true, fileExists: () => true };
  if (refsExist(irc, '/tmp', allOk).length === 0) ok('refs-no-false-positive');
  else ng('refs-no-false-positive', '実在するのに未到達と判定した');
}

console.log(`\n${pass} 件 pass / ${fail} 件 fail`);
process.exit(fail === 0 ? 0 : 1);
