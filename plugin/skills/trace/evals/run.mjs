#!/usr/bin/env node
// 仕込んだ欠陥を validate() が拾えるかを測る。加えて、外部由来のテキストが
// HTML と JSON の境界を越えないことと、IR が往復で一致することを見る。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validate, extractIr, embedJson } from '../lib/ir.mjs';
import { render, briefing } from '../lib/render.mjs';
import { collect } from '../lib/collect.mjs';
import { cover, refsExist } from '../lib/cover.mjs';

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

// 外部由来のテキストは信頼境界。issue 本文にも stderr にも入りうる。
console.log('境界:');
const hostile = '</script><img src=x onerror=alert(1)> <!--</SCRIPT>';
const ir = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
ir.events[0].text = hostile;
ir.glossary[0].meaning = hostile;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-eval-')), 'x.html');
render(ir, out);
const html = fs.readFileSync(out, 'utf8');
const embedded = html.slice(html.indexOf('id="progress-ir"'), html.indexOf('</script>'));
if (/<\/script>/i.test(embedded)) ng('embed-closes-script', 'IR の中で script が閉じている'); else ok('embed-closes-script');
// 見るのは**生のタグが立っているか**だけ。エスケープ済みテキストの中には
// "onerror=" のような文字列がそのまま残るが、< が &lt; になっていれば無害である。
// ここを文字列一致で見ると、正しくエスケープされたものを失敗と判定する。
{
  const body = html.slice(html.indexOf('<body>'));
  const stripped = body.replace(/<script>[\s\S]*?<\/script>/g, '');
  if (/<img/i.test(stripped) || /<script/i.test(stripped)) ng('body-escapes', '本文に生のタグが立っている');
  else ok('body-escapes');
}
const back = extractIr(html);
if (back.events[0].text !== hostile) ng('round-trip', 'IR が往復で変わった'); else ok('round-trip');
if (JSON.stringify(back) !== JSON.stringify(ir)) ng('round-trip-full', 'IR 全体が往復で一致しない'); else ok('round-trip-full');

// 再開の要約は、通ってはいけない道を必ず含む。ここが落ちると再開時に同じ道を通る。
const b = briefing(JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8')));
for (const [label, needle] of [['ng-section', '通ってはいけない道'], ['ng-dead-end', '通って駄目だった'], ['ng-superseded', '一度採って覆した'], ['ng-rejected', '検討して棄却済み'], ['next-first', '## 次にやること'], ['uncertainty', 'まだ未知が残っている']]) {
  if (b.includes(needle)) ok(label); else ng(label, `要約に「${needle}」が無い`);
}
// 行動の順: 次にやること が 決まっていること より前に来る
if (b.indexOf('## 次にやること') < b.indexOf('## 決まっていること')) ok('order'); else ng('order', '次にやることが後ろにある');
// 棄却した案は名前と参照先だけを載せる。理由の全文を戻すと、決定が増えるほど
// 要約が全文へ近づき、「要約から入る」という設計が成立しなくなる。
{
  const ir3 = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  const b3 = briefing(ir3);
  const rejected = ir3.decisions.find((x) => x.status === 'accepted').options.find((o) => o.chosen !== true);
  if (b3.includes(`（理由は ${ir3.decisions.find((x) => x.status === 'accepted').id}）`)) ok('brief-points-to-decision');
  else ng('brief-points-to-decision', '棄却した案に決定 id への参照が無い');
  if (b3.includes(rejected.option)) ok('brief-names-rejected'); else ng('brief-names-rejected', '棄却した案の名前が要約に無い');
  if (!b3.includes(rejected.whyNot)) ok('brief-omits-why-not'); else ng('brief-omits-why-not', '棄却理由の全文が要約に載っている');
}

// debt は「直しにいかないもの」として要約に出る。出ないと後任が意図を欠陥と読む。
{
  const d = briefing(JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'with-debt.json'), 'utf8')));
  if (d.includes('意図して残している')) ok('ng-debt'); else ng('ng-debt', '要約に意図して残した負債が無い');
}
// 未知が無いときは、そう書く。無言だと「調べ終わっている」と誤読される。
{
  const ir2 = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  ir2.openQuestions = ir2.openQuestions.map((q) => ({ ...q, blocking: false }));
  if (briefing(ir2).includes('未知は残っていない')) ok('uncertainty-clear'); else ng('uncertainty-clear', '未知が無いことが書かれない');
}

// Markdown は、本文が ID で参照するものに ID を印字していること。
// 印字していないと「ID なら検索で引ける」という期待が裏切られ、探索が一番遅くなる。
console.log('Markdown:');
{
  const irm = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  const out2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-md-')), 'y.html');
  render(irm, out2);
  const md = fs.readFileSync(out2.replace(/\.html$/, '.md'), 'utf8');
  for (const [label, id] of [['md-event-id', irm.events[0].id], ['md-verification-id', irm.verification[0].id], ['md-question-id', irm.openQuestions[0].id], ['md-decision-id', irm.decisions[0].id]]) {
    if (md.includes(id)) ok(label); else ng(label, `${id} が Markdown に印字されていない`);
  }
  // 記録自身が引用している規約（水平線を使わない）に、生成物が違反しないこと
  if (!/^---$/m.test(md)) ok('md-no-horizontal-rule'); else ng('md-no-horizontal-rule', '水平線が出力されている');
  // 見出しは ID だけ。1 文まるごとの見出しは一覧に使えない
  if (md.includes(`### ${irm.decisions[0].id}\n`)) ok('md-short-heading'); else ng('md-short-heading', '決定の見出しが ID だけになっていない');
  // md が指す HTML のファイル名は、実際に書き出した名前でなければならない。
  // meta.id から組み立てると、接尾辞が変わったときに存在しない名前を書く。
  const realName = path.basename(out2);
  if (md.includes(realName)) ok('md-points-to-real-html'); else ng('md-points-to-real-html', `md が ${realName} を指していない`);
  if (!md.includes(`${irm.meta.id}.html\``)) ok('md-no-fabricated-name'); else ng('md-no-fabricated-name', '存在しないファイル名を書いている');
  // 素の `progress` は PATH に無い。読み手がコピーして空振りする。
  if (!/(?<![./\w])progress (read|render) /.test(md)) ok('md-no-bare-command');
  else ng('md-no-bare-command', 'md に素の progress コマンドが残っている');
}

// HTML と Markdown は同じ IR から出るのに、節を別々に書いているのでずれる。
// 実測: Markdown が工程（phases）を落としていて、md を読む側に「どこまで進んだか」が届いていなかった。
// IR に入れた内容が両方へ出ているかを、識別子と固有の文字列で突き合わせる。
console.log('HTML と Markdown の一致:');
{
  const irp = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'clean.json'), 'utf8'));
  const outp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-par-')), 'z.html');
  render(irp, outp);
  const H = fs.readFileSync(outp, 'utf8');
  const Hbody = H.slice(H.indexOf('<body>'));           // 埋め込み IR は数えない
  const M = fs.readFileSync(outp.replace(/\.html$/, '.md'), 'utf8');
  const targets = [
    ...irp.current.phases.map((p) => ['phase', p.label]),
    ...irp.events.map((e) => ['event', e.id]),
    ...irp.decisions.map((d) => ['decision', d.id]),
    ...irp.verification.map((v) => ['verification', v.id]),
    ...irp.openQuestions.map((q) => ['question', q.id]),
    ...irp.glossary.map((g) => ['glossary', g.term]),
    ...irp.background.nonGoals.map((x) => ['non-goal', x.slice(0, 24)]),
    ...irp.background.constraints.map((x) => ['constraint', x.slice(0, 24)]),
    ...(irp.links.issues || []).map((i) => ['issue', i.key]),
    ...(irp.links.prs || []).map((p) => ['pr', String(p.number)]),
  ];
  const missing = [];
  for (const [kind, needle] of targets) {
    const inH = Hbody.includes(needle), inM = M.includes(needle);
    if (!inH || !inM) missing.push(`${kind} "${needle}" が ${!inH ? 'HTML' : 'Markdown'} に無い`);
  }
  if (missing.length === 0) ok(`parity（${targets.length} 項目）`);
  else for (const msg of missing.slice(0, 6)) ng('parity', msg);
}

// 既定の表示は、いまの工程を開いてそれ以前を畳む。**データは削らない。**
// 畳んだ中身が消えていると、記録としての「漏れなく」が壊れる。
console.log('折りたたみ:');
{
  const irf = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'phased.json'), 'utf8'));
  const outf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-fold-')), 'f.html');
  render(irf, outf);
  const H = fs.readFileSync(outf, 'utf8');
  const body = H.slice(H.indexOf('<body>'));
  // 進行中の工程（retry）は開き、それ以前（design）は details に入る
  if (/<details><summary>設計/.test(body)) ok('fold-past-phase'); else ng('fold-past-phase', '過去の工程が畳まれていない');
  if (/<h3>再実行<\/h3>/.test(body)) ok('fold-current-open'); else ng('fold-current-open', 'いまの工程が開いていない');
  // 畳んでも中身は全部ある
  for (const e of irf.events) {
    if (!body.includes(e.id)) { ng('fold-keeps-all', `${e.id} が消えている`); break; }
  }
  if (irf.events.every((e) => body.includes(e.id))) ok('fold-keeps-all');
  // 件数の閾値でデータを削っていないこと
  const md = fs.readFileSync(outf.replace(/\.html$/, '.md'), 'utf8');
  if (irf.events.every((e) => md.includes(e.id))) ok('fold-md-unaffected'); else ng('fold-md-unaffected', 'md 側で欠けている');
}

// 記録をまたぐ参照と、決定と検証の接続。
// 「3 か月前の別作業の決定をいま覆した」と「決めたのに確かめていない決定」は、
// どちらも DB の中核になるのに、記録の側で表現できていなかった。
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
  // 表示: 別の記録への参照をリンクにしない（必ず切れる）
  const outr = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-ref-')), 'r.html');
  x = base(); x.decisions[1].supersededBy = 'other-record#d-foo';
  render(x, outr);
  const H2 = fs.readFileSync(outr, 'utf8');
  if (!H2.includes('href="#other-record#d-foo"')) ok('ref-not-linked'); else ng('ref-not-linked', '別記録への参照をアンカーにしている');
  if (H2.includes('未検証')) ok('unverified-shown'); else ng('unverified-shown', '未検証のバッジが出ていない');
}

// 工程は時刻から導出する。events[].phase を宣言させると書かれずに腐る
// （実測: 例 5 件・実記録 34 件のいずれも phase 記入 0 件で、折りたたみが発火しなかった）。
console.log('工程の導出:');
{
  const irx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'phase-from.json'), 'utf8'));
  if (irx.events.every((e) => !e.phase)) ok('derive-no-declared-phase');
  else ng('derive-no-declared-phase', 'fixture に phase が書かれている');
  const outx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-der-')), 'd.html');
  render(irx, outx);
  const body = fs.readFileSync(outx, 'utf8');
  if (/<details><summary>設計/.test(body)) ok('derive-folds-by-time');
  else ng('derive-folds-by-time', '時刻から工程を決めて畳めていない');
  if (irx.events.every((e) => body.includes(e.id))) ok('derive-keeps-all');
  else ng('derive-keeps-all', '導出で消えたエントリがある');
  // 現在の工程にエントリが無くても、必ずどこかが開いている。
  // 全部畳まれると「いま何が起きているか」が 1 つも見えない。
  const iry = JSON.parse(JSON.stringify(irx));
  iry.current.phases.push({ id: 'release', label: 'リリース', state: 'doing', from: '2099-01-01T00:00:00+09:00' });
  iry.current.phases = iry.current.phases.map((p) => (p.id === 'retry' ? { ...p, state: 'done' } : p));
  const outy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-open-')), 'o.html');
  render(iry, outy);
  const b2 = fs.readFileSync(outy, 'utf8');
  const evBody = b2.slice(b2.indexOf('<h2 id="events">'));
  if (/<h3>/.test(evBody)) ok('always-one-open'); else ng('always-one-open', '全部畳まれて開いている工程が無い');
}

// 採掘: 人の発話と通知を取り違えないこと。**ターン中の発言を落とさないこと。**
// 落ちても transcript には残るので痕跡が出ない。ここで押さえないと気付けない。
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
