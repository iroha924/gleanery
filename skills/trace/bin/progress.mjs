#!/usr/bin/env node
// progress-log の CLI。Node の標準ライブラリだけで動く（依存のインストールは要らない）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validate, extractIr, emptyIr, SCHEMA } from '../lib/ir.mjs';
import { collect, findTranscript } from '../lib/collect.mjs';
import { render, briefing } from '../lib/render.mjs';
import { cover, refsExist } from '../lib/cover.mjs';

const HOME = os.homedir();
// 要約に埋め込む呼び出し方は、実際に走っている自分のパスにする。
// 相対パスを書くと、cwd がプロジェクト側の Claude Code では当たらない。
const SELF = fileURLToPath(import.meta.url);
// 保管先はプロジェクトのルート。記録がコードと同じ場所にあると、ソース管理に載って
// コードと同期が保て、リポジトリを開いた人がそのまま見つけられる。
// PROGRESS_HOME で 1 箇所へ集約する使い方も残す。
function projectRoot(from) {
  try {
    return execFileSync('git', ['-C', from, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return from; } // git 管理外ならそこを root として扱う
}
const STORE = process.env.PROGRESS_HOME || projectRoot(process.cwd());
const SUFFIX = '.progress.html';

const usage = () => `使い方:
  progress find [語]                    既存の記録を探す。**起動したら必ず最初にこれ**
  progress resume [語]                  前回の続きから始めるための要約を出す（行動の順に並ぶ）
  progress show <id>                    id で指した 1 件を引く（d-xxx / e-xxx / v-xxx / q-xxx）
  progress collect [--cwd <path>] [--transcript <path>] [--out <file>]
                                        いまのセッションから検証できる値だけを取り出す
  progress cover <digest.json> <ir.json>  材料にあったのに記録へ入らなかったものを探す
  progress validate <ir.json>           契約を検査する
  progress render <ir.json> [--out <html>]  html と md を書く
  progress read <html>                  埋め込まれた IR を取り出す（追記するとき）
  progress doctor                       置き場所と同梱ファイルを確かめる

共通: --json で機械可読に出す
保管先: ${STORE}
  プロジェクトのルート直下に <id>.progress.html と <id>.progress.md の 2 本を置く。
  PROGRESS_HOME を指定すると、そこへ集約する（<repo>/ の 1 段まで見る）。`;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def = null) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : args[i + 1]; };
const jsonOut = args.includes('--json');
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const htmlFiles = (dir, out = []) => {
  let es = [];
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.isFile() && e.name.endsWith(SUFFIX)) out.push(path.join(dir, e.name));
    // PROGRESS_HOME で 1 箇所へ集約したときは <repo>/ の 1 段だけ潜る。
    else if (e.isDirectory() && !e.name.startsWith('.') && dir === STORE) {
      for (const f of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(SUFFIX)) out.push(path.join(dir, e.name, f.name));
      }
    }
  }
  return out;
};

function loadStore() {
  const found = [];
  for (const f of htmlFiles(STORE)) {
    let ir = null;
    try { ir = extractIr(fs.readFileSync(f, 'utf8')); } catch { /* 壊れた 1 枚で全体を止めない */ }
    if (ir?.schema === SCHEMA) found.push({ file: f, ir });
  }
  return found;
}

const readIrFile = (p) => {
  if (!p) die('IR のパスが要る。');
  if (!fs.existsSync(p)) die(`ファイルが無い: ${p}`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`JSON として読めない: ${e.message}`); }
};

if (!cmd || cmd === '--help' || cmd === '-h') { console.log(usage()); process.exit(0); }

if (cmd === 'find') {
  // 同じ issue を二重に作らないための入口。issue のキー・URL・題・id のどれでも当たる。
  const q = args.slice(1).filter((a) => !a.startsWith('--')).join(' ').toLowerCase();
  const hits = loadStore().filter(({ ir }) => {
    if (!q) return true;
    const keys = (ir.links?.issues || []).flatMap((i) => [i.key, i.url]).filter(Boolean);
    const prs = (ir.links?.prs || []).map((p) => `#${p.number}`);
    return [ir.meta.id, ir.meta.title, ir.meta.repo, ...keys, ...prs].filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  }).map(({ file, ir }) => ({
    file, id: ir.meta.id, title: ir.meta.title, status: ir.meta.status,
    repo: ir.meta.repo, updated: ir.meta.updated,
    issues: (ir.links?.issues || []).map((i) => i.key || i.url).filter(Boolean),
  })).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));

  if (jsonOut) { console.log(JSON.stringify({ store: STORE, count: hits.length, hits }, null, 2)); process.exit(0); }
  if (hits.length === 0) { console.log(`該当なし（${STORE}）。新規に作る。`); process.exit(0); }
  console.log(`${hits.length} 件:`);
  for (const h of hits) console.log(`  ${h.id}  [${h.status}]  ${h.title}\n    ${h.file}\n    issue: ${h.issues.join(', ') || '-'}  更新 ${h.updated}`);
  process.exit(0);
}

if (cmd === 'show') {
  // 要約も Markdown も id で参照するので、id から実体を引ける入口が要る。
  // これが無いと、参照を追うたびに全文を開いて目で探すことになる。
  const id = args[1];
  if (!id) die('id が要る。progress show <id>');
  const found = [];
  for (const { file, ir } of loadStore()) {
    for (const [kind, list] of [['decision', ir.decisions], ['event', ir.events], ['verification', ir.verification], ['question', ir.openQuestions]]) {
      for (const x of list || []) if (x.id === id) found.push({ file, ir, kind, entry: x });
    }
  }
  if (found.length === 0) die(`id が見つからない: ${id}（探した場所: ${STORE}）`, 1);
  if (jsonOut) { console.log(JSON.stringify(found.map(({ file, kind, entry }) => ({ file, kind, entry })), null, 2)); process.exit(0); }

  for (const { file, ir, kind, entry: x } of found) {
    console.log(`# ${x.id}  [${kind}]`);
    console.log(`${ir.meta.title}（${file}）\n`);
    if (kind === 'decision') {
      console.log(`**${x.decision}**\n`);
      console.log(`状態: ${x.status}${x.supersededBy ? ` → ${x.supersededBy}` : ''} / ${x.at}\n`);
      console.log(`## 文脈\n${x.context}\n`);
      console.log('## 検討した案');
      for (const o of x.options || []) console.log(o.chosen ? `- 採用: ${o.option}` : `- 棄却: ${o.option} — ${o.whyNot}`);
      console.log('\n## 結果');
      for (const c of x.consequences || []) console.log(`- ${c.good === false ? '(不利) ' : ''}${c.text}`);
      console.log(`\n## 守られていることの確かめ方\n${x.confirmation}`);
    } else if (kind === 'verification') {
      console.log(`[${x.result}] ${x.what} / ${x.at}`);
      if (x.cmd) console.log(`\n実行: ${x.cmd}`);
      if (x.output) console.log(`\n出力:\n${x.output}`);
      if (x.whyNotRun) console.log(`\n未実行の理由: ${x.whyNotRun}`);
    } else if (kind === 'question') {
      console.log(`${x.blocking ? '[これが埋まるまで進めない] ' : ''}${x.q}`);
      console.log(`\n答えるのは ${x.who === 'human' ? '人' : 'AI'} / ${x.when} / ${x.at}`);
    } else {
      console.log(`[${x.kind}]${x.confidence && x.confidence !== 'fact' ? ` [${x.confidence}]` : ''} ${x.at}\n`);
      console.log(x.text);
    }
    if (x.evidence && x.evidence.length) {
      console.log('\n## 根拠');
      for (const e of x.evidence) console.log(`- ${e.kind} ${e.ref}${e.exit === undefined || e.exit === null ? '' : ` (exit ${e.exit})`}${e.note ? ` — ${e.note}` : ''}`);
    }
    console.log('');
  }
  process.exit(0);
}

if (cmd === 'resume') {
  // 再開の入口。1 件に絞れたときだけ要約を出す。取り違えると前提ごと間違うので、
  // 複数当たったら選ばせる。0 件を「無い」と言い切らず、探した場所を示す。
  const q = args.slice(1).filter((a) => !a.startsWith('--')).join(' ').toLowerCase();
  const all = loadStore();
  const hits = q ? all.filter(({ ir }) => {
    const keys = (ir.links?.issues || []).flatMap((i) => [i.key, i.url]).filter(Boolean);
    const prs = (ir.links?.prs || []).map((p) => `#${p.number}`);
    return [ir.meta.id, ir.meta.title, ir.meta.repo, ...keys, ...prs].filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  }) : all;
  if (hits.length === 0) die(`該当なし（探した場所: ${STORE}）。記録が無いのか、語が違うのかは区別できない。progress find で一覧を見る。`, 1);
  if (hits.length > 1) {
    console.error(`${hits.length} 件あるので絞れない。どれを再開するか決める:`);
    for (const h of hits) console.error(`  ${h.ir.meta.id}  [${h.ir.meta.status}]  ${h.ir.meta.title}  更新 ${h.ir.meta.updated}`);
    process.exit(1);
  }
  const { file, ir } = hits[0];
  const text = briefing(ir, { html: file, invoke: SELF });
  if (jsonOut) console.log(JSON.stringify({ file, updated: ir.meta.updated, briefing: text }, null, 2));
  else console.log(text);
  process.exit(0);
}

if (cmd === 'collect') {
  // transcript が持つ cwd は絶対パスなので、相対で渡されても解決してから突き合わせる。
  const cwd = path.resolve(flag('cwd', process.cwd()));
  const explicit = flag('transcript');
  const t = explicit ? { file: explicit, host: flag('host', 'claude-code') } : findTranscript(cwd);
  if (!t) die(`${cwd} に対応する transcript が見つからない。--transcript で明示するか、採掘なしで進める。`);
  const digest = collect(t.file, t.host, cwd);
  const out = flag('out');
  const text = JSON.stringify(digest, null, 2);
  if (out) { fs.writeFileSync(out, text); console.log(`${out}  ${digest.host}  人の発話 ${digest.userMessages.length}（通知 ${digest.notifications} 件は除外）${digest.compactions ? ` / compact ${digest.compactions} 回` : ''} / 選択 ${digest.choices.length} / コマンド ${digest.commands.length}（失敗 ${digest.failedCommands.length}） / ツール経由のファイル ${digest.files.length} / git の変更 ${digest.git?.changed.length ?? '-'} / コミット ${digest.git?.commits.length ?? '-'}`); }
  else console.log(text);
  process.exit(0);
}

if (cmd === 'cover') {
  const digest = readIrFile(args[1]);
  const ir = readIrFile(args[2]);
  const r = cover(digest, ir);
  if (jsonOut) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  for (const g of r.groups) {
    const n = g.missing.length;
    const mark = n === 0 ? '✓' : g.blocking ? '✗' : '!';
    console.error(`${mark} ${g.label}: 材料に ${g.total} 件 / 記録に無いもの ${n} 件`);
    for (const m of g.missing.slice(0, 8)) console.error(`    - ${m}`);
    if (g.missing.length > 8) console.error(`    ...ほか ${g.missing.length - 8} 件`);
    if (n > 0) console.error(`    → ${g.fix}`);
  }
  // 参照先の実在。ネットワークを使わないものだけを見る。
  const root = process.env.PROGRESS_REPO || STORE;
  const bad = refsExist(ir, root, {
    commitExists: (sha) => {
      try { execFileSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }); return true; }
      catch { return false; }
    },
    fileExists: (p) => fs.existsSync(path.isAbsolute(p) ? p : path.join(root, p)),
  });
  console.error(`${bad.length === 0 ? '✓' : '!'} 参照先の実在: 到達できないもの ${bad.length} 件`);
  for (const b of bad.slice(0, 8)) console.error(`    - ${b.where}: ${b.kind} ${b.ref}`);
  if (bad.length) console.error('    → 実在する識別子へ直すか、証拠から外す。書いた時点では在ったが消えたなら、その旨を note に残す');
  if (r.note) console.error(`! ${r.note}`);
  console.error(r.ok ? '\n人が選んだ決定は全部入っている' : '\n人が選んだ決定が記録に無い。これは落としてはいけない');
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'validate') {
  const ir = readIrFile(args[1]);
  const r = validate(ir);
  if (jsonOut) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  for (const w of r.warnings) console.error(`警告 [${w.code}] ${w.message}\n      → ${w.fix}`);
  for (const p of r.problems) console.error(`違反 [${p.code}] ${p.message}\n      → ${p.fix}`);
  console.error(r.ok ? `契約を満たしている（警告 ${r.warnings.length} 件）` : `違反 ${r.problems.length} 件 / 警告 ${r.warnings.length} 件`);
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'render') {
  const ir = readIrFile(args[1]);
  const r = validate(ir);
  if (!r.ok) { // 通っていないものは描かない。壊れた記録を残すより、描かないほうがよい
    for (const p of r.problems) console.error(`違反 [${p.code}] ${p.message}\n      → ${p.fix}`);
    die(`検証を通っていないので描かない（違反 ${r.problems.length} 件）。progress validate で直す。`, 1);
  }
  const out = flag('out') || path.join(STORE, `${ir.meta.id}${SUFFIX}`);
  // 同じファイルを 2 つのセッションが同時に触ったとき、後から書いたほうが前を消す。
  // 読んだときの updated と、いまディスクにあるものを突き合わせて止める。
  if (fs.existsSync(out)) {
    const disk = extractIr(fs.readFileSync(out, 'utf8'));
    const base = flag('base-updated');
    if (base && disk?.meta?.updated && disk.meta.updated !== base) {
      die(`書き込み先が読み込み後に更新されている。\n  読んだ時点: ${base}\n  いまの中身: ${disk.meta.updated}\n  取り込み直してから書く。`, 1);
    }
  }
  const res = render(ir, out, SELF);
  const msg = { output: res.htmlPath, markdown: res.mdPath, bytes: res.bytes, mdBytes: res.mdBytes, warnings: r.warnings.length };
  console.log(jsonOut ? JSON.stringify(msg, null, 2)
    : `${res.htmlPath}  ${(res.bytes / 1024).toFixed(0)}KB\n${res.mdPath}  ${(res.mdBytes / 1024).toFixed(0)}KB\n警告 ${r.warnings.length} 件`);
  process.exit(0);
}

if (cmd === 'read') {
  const p = args[1];
  if (!p || !fs.existsSync(p)) die(`HTML が無い: ${p}`);
  const ir = extractIr(fs.readFileSync(p, 'utf8'));
  if (!ir) die(`IR が埋め込まれていない: ${p}`);
  console.log(JSON.stringify(ir, null, 2));
  process.exit(0);
}

if (cmd === 'doctor') {
  const here = path.resolve(path.dirname(SELF), '..');
  const rows = [
    ['保管先', STORE, fs.existsSync(STORE)],
    ['テンプレート', path.join(here, 'assets/template.html'), fs.existsSync(path.join(here, 'assets/template.html'))],
    ['例', path.join(here, 'examples/example.progress.json'), fs.existsSync(path.join(here, 'examples/example.progress.json'))],
  ];
  for (const [k, v, ok] of rows) console.log(`${ok ? '✓' : '✗'} ${k}: ${v}`);
  console.log(`記録の数: ${loadStore().length}`);
  process.exit(0);
}

die(`知らないコマンド: ${cmd}\n\n${usage()}`);
