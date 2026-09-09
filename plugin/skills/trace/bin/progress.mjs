#!/usr/bin/env node
// progress-log の CLI。Node の標準ライブラリだけで動く（依存のインストールは要らない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validate } from '../lib/ir.mjs';
import { collect, findTranscript } from '../lib/collect.mjs';
import { cover, refsExist } from '../lib/cover.mjs';
import { applyPatch } from '../lib/patch.mjs';

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
const REPO = projectRoot(process.cwd());

const usage = () => `使い方:
  progress collect [--cwd <path>] [--transcript <path>] [--out <file>]
                                        いまのセッションから検証できる値だけを取り出す
  progress cover <digest.json> <ir.json>  材料にあったのに記録へ入らなかったものを探す
  progress patch <ir.json> <patch.json> 記録へ変更を当てる（追記・上書き・覆した印）
  progress validate <ir.json>           契約を検査する
  progress doctor                       同梱ファイルと、記録の行き先を確かめる

共通: --json で機械可読に出す

**IR を直すのに書き捨てのスクリプトを作らない。**patch は JSON を受け取り、
追記できる欄・上書きできる欄・id の再利用を、当てる側で拒否する。

**記録はファイルではなく DB に置く。**書くのは \`mitos ingest <ir.json>\`、
読むのは MCP の \`current_work\`（現在地）と \`search_knowledge\`（過去の判断）。
このスキルの仕事は IR を作って検査するところまでで、HTML も Markdown も出さない。`;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def = null) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : args[i + 1]; };
const jsonOut = args.includes('--json');
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const readIrFile = (p) => {
  if (!p) die('IR のパスが要る。');
  if (!fs.existsSync(p)) die(`ファイルが無い: ${p}`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`JSON として読めない: ${e.message}`); }
};

if (!cmd || cmd === '--help' || cmd === '-h') { console.log(usage()); process.exit(0); }

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
  const root = process.env.PROGRESS_REPO || REPO;
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

if (cmd === 'patch') {
  const irPath = args[1];
  const ir = readIrFile(irPath);
  const patch = readIrFile(args[2]);
  const r = applyPatch(ir, patch);
  if (jsonOut) { console.log(JSON.stringify({ ok: r.ok, changes: r.changes, problems: r.problems }, null, 2)); }
  else {
    for (const p of r.problems) console.error(`違反 [${p.code}] ${p.message}\n      → ${p.fix}`);
    for (const c of r.changes) console.error(`  ${c}`);
  }
  // **1 つでも違反があれば書かない。**半分だけ当たった IR が残ると、
  // 何が入って何が入らなかったかを後から判定できない。
  if (!r.ok) { console.error(`違反 ${r.problems.length} 件。書き込んでいない`); process.exit(1); }
  fs.writeFileSync(irPath, `${JSON.stringify(r.ir, null, 2)}\n`);
  console.error(`${irPath} へ ${r.changes.length} 件を当てた`);
  process.exit(0);
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

if (cmd === 'doctor') {
  const here = path.resolve(path.dirname(SELF), '..');
  const rows = [
    ['リポジトリ', REPO, fs.existsSync(REPO)],
    ['例', path.join(here, 'examples/example.progress.json'), fs.existsSync(path.join(here, 'examples/example.progress.json'))],
  ];
  for (const [k, v, ok] of rows) console.log(`${ok ? '✓' : '✗'} ${k}: ${v}`);
  console.log('記録は DB にある。読むのは MCP の current_work と search_knowledge、書くのは mitos ingest <ir.json>');
  process.exit(0);
}

die(`知らないコマンド: ${cmd}\n\n${usage()}`);
