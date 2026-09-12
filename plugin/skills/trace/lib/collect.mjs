// セッションの記録から、**検証できる値だけ**を取り出す。
//
// 解釈（なぜそうしたか、何が重要か）はここでは作らない。モデルが書いて inference の印を付ける。
// 自動生成された記録を人が検証しろ、という要求（Devin の Knowledge onboarding）に対する
// こちら側の答えが、この境界である。会話が compact で消えても、この記録には残っている。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();

/** 要件定義と設計書の path。DB 側（server/src/artifacts.ts の ARTIFACT_PATH）と同じ形にする。 */
export const ARTIFACT = /^\.mitos\/changes\/[a-z0-9]+(?:-[a-z0-9]+)*\/(requirements|design)\.md$/;

const readLines = function* (file) {
  // 42MB の transcript でも一度に読んで問題ない（実測 0.1 秒）。
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* 壊れた行は飛ばす。途中で落とさない */ }
  }
};

const walk = (dir, out = []) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
};

/** cwd に合う transcript のうち、最後に書かれたものを返す。走っている session がそれ。 */
export function findTranscript(cwd) {
  const claudeRoots = [path.join(HOME, '.claude', 'projects')];
  const ccs = path.join(HOME, '.ccs', 'instances');
  try {
    claudeRoots.push(...fs.readdirSync(ccs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(ccs, entry.name, 'projects')));
  } catch { /* ccs を使っていなければ既定の置き場所だけを見る */ }
  const codexRoot = path.join(HOME, '.codex', 'sessions');
  const candidates = [];

  for (const root of claudeRoots) {
    for (const f of walk(root)) {
      if (f.includes(`${path.sep}subagents${path.sep}`)) continue;
      let foundCwd = null;
      let sessionId = null;
      for (const o of readLines(f)) {
        foundCwd ||= o.cwd;
        sessionId ||= o.sessionId;
        if (foundCwd && sessionId) break;
      }
      // slug の作り方はホストの実装詳細なので、パスからは推測しない。中の cwd を見る。
      if (foundCwd === cwd) candidates.push({ host: 'claude-code', sessionId, file: f });
    }
  }
  for (const f of walk(codexRoot)) {
    for (const o of readLines(f)) {
      if (o.type === 'session_meta') {
        if (o.payload?.cwd === cwd) candidates.push({ host: 'codex', sessionId: o.payload?.id, file: f });
        break;
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);

  // 同じ cwd で複数セッションが並列に動くため、更新時刻だけで選ばない。
  // Claude Code / Codex は Bash の子プロセスへ現在のセッション ID を渡す。
  const current = process.env.CLAUDE_CODE_SESSION_ID
    ? { host: 'claude-code', id: process.env.CLAUDE_CODE_SESSION_ID }
    : process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID
      ? { host: 'codex', id: process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID }
      : null;
  if (current) {
    const exact = candidates.find((candidate) => candidate.host === current.host && candidate.sessionId === current.id);
    if (exact) return exact;
  }
  return candidates[0];
}

const digestShell = (cmd) => String(cmd || '').replace(/\s+/g, ' ').trim().slice(0, 400);

// user ロールで届くが、人が打ったものではないもの。**有限の固定リストにする。**
// 「通知らしさ」を推定し始めると、塞ぐ面に終端が無くなり、本物の発話を落とす。
// これを分けないと「ユーザーの指示 11 件」のような、事実でない数を記録に書くことになる。
const NOT_FROM_HUMAN = [
  'This session is being continued from a previous conversation',
  '<command-message>',
  '<task-notification>',
  '<system-reminder>',
  '<cross-session-message',
  'Another Claude session sent a message:',
];
const fromHuman = (entry, text) => {
  if (entry.isMeta === true) return false;           // スキル本文の注入
  if (entry.isCompactSummary === true) return false; // compact が挿入した要約
  const t = String(text || '').trimStart();
  return !NOT_FROM_HUMAN.some((m) => t.startsWith(m));
};

function collectClaude(file) {
  const d = blank('claude-code', file);
  const pending = new Map(); // tool_use_id -> {name, input}
  for (const o of readLines(file)) {
    if (o.timestamp) { d.from ||= o.timestamp; d.to = o.timestamp; }
    if (o.cwd) d.cwd = o.cwd;
    if (o.gitBranch) d.branch = o.gitBranch;
    if (o.sessionId) d.sessionId = o.sessionId;
    // ターンの途中で送られた発言は type: user ではなく queue-operation に入る。
    // ここを見ないと、**作業中に方針を変えた指示がまるごと落ちる**（実測: 設計を変えた
    // 3 件が 1 件も拾えていなかった）。通知も同じ経路で来るので、同じ判定にかける。
    // compact は transcript を切らない。要約が同じファイルの途中へ挿入されるだけで、
    // compact 前の会話はその上にそのまま残る（実測: 10,429 行の 1,869 行目に挿入、sessionId は不変）。
    // だから採掘は compact をまたいでも漏れない。何回またいだかは digest に残す。
    if (o.isCompactSummary === true) d.compactions += 1;
    if (o.type === 'queue-operation' && o.operation === 'enqueue') { addUserText(d, o, o.content); continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const c = o.message?.content;
    if (typeof c === 'string') {
      if (o.type === 'user') addUserText(d, o, c);
      else addAssistantText(d, o, c);
      continue;
    }
    for (const b of c || []) {
      if (b.type === 'text') {
        if (o.type === 'user') addUserText(d, o, b.text);
        else addAssistantText(d, o, b.text);
      }
      if (b.type === 'tool_use') {
        d.inputs.push(JSON.stringify(b.input ?? {}));
        // AskUserQuestion は、選択肢と各案のトレードオフを示したうえで人が選んだ記録である。
        // decisions がまさに欲しい形（文脈・検討した案・採った案）がそのまま残っているのに、
        // ツールの一種として数えるだけでは中身が落ちる。実測: このスキルの読み手・ファイル単位・
        // 保管先を決めた 3 件が、記録に 1 件も入らなかった。
        if (b.name === 'AskUserQuestion') {
          for (const q of b.input?.questions || []) {
            d.choices.push({
              at: o.timestamp,
              question: q.question,
              options: (q.options || []).map((x) => ({ label: x.label, why: x.description })),
              answer: null,
            });
          }
        }
        d.toolCounts[b.name] = (d.toolCounts[b.name] || 0) + 1;
        pending.set(b.id, { name: b.name, input: b.input || {}, at: o.timestamp });
        const i = b.input || {};
        if (i.file_path) touch(d, i.file_path, b.name);
        if (b.name === 'WebFetch' || b.name === 'WebSearch') push(d.urls, String(i.url || i.query || '').slice(0, 300));
        if (b.name === 'Agent') push(d.agents, String(i.description || i.subagent_type || '').slice(0, 120));
      }
      if (b.type === 'tool_result') {
        const p = pending.get(b.tool_use_id);
        if (p?.name === 'AskUserQuestion') {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          // 「"問い"="答え"」の並びで返る。取れなければ未回答のままにする（推測で埋めない）。
          for (const m of text.matchAll(/"([^"]{4,})"="([^"]*)"/g)) {
            const hit = d.choices.find((c) => c.question.startsWith(m[1].slice(0, 20)) && c.answer === null);
            if (hit) hit.answer = m[2];
          }
        }
        if (p?.name === 'Bash') {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          const exit = /^Exit code (\d+)/.exec(text)?.[1];
          d.commands.push({
            at: p.at,
            cmd: digestShell(p.input.command),
            failed: b.is_error === true,
            exit: exit ? Number(exit) : b.is_error ? null : 0,
            error: b.is_error ? text.replace(/\s+/g, ' ').slice(0, 300) : undefined,
          });
        }
        pending.delete(b.tool_use_id);
      }
    }
    if (o.toolUseResult?.structuredPatch && o.toolUseResult.filePath) {
      touch(d, o.toolUseResult.filePath, 'edit', o.toolUseResult.structuredPatch.length);
    }
  }
  return finish(d);
}

function collectCodex(file) {
  const d = blank('codex', file);
  // 出力は call_id で呼び出しに紐付く。**ただし exit code は載っていない**
  // （実測: "Script completed / Wall time ..." だけで終了状態が無い）。
  // 出力の文字列から失敗を推測すると、塞ぐ面に終端が無くなる。だから推測しない。
  const outputs = new Map();
  for (const o of readLines(file)) {
    const p = o.payload || {};
    if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const out = p.output;
      const text = Array.isArray(out) ? out.map((b) => (b && b.text) || '').join('') : String(out ?? '');
      if (p.call_id) outputs.set(p.call_id, text.slice(0, 2000));
    }
  }
  for (const o of readLines(file)) {
    if (o.timestamp) { d.from ||= o.timestamp; d.to = o.timestamp; }
    if (o.type === 'session_meta') { d.cwd = o.payload?.cwd || d.cwd; d.sessionId = o.payload?.id || d.sessionId; }
    const p = o.payload || {};
    if (o.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const text = (p.content || []).map((x) => x.text || '').join('').trim();
        if (text && p.role === 'user') addUserText(d, o, text);
        if (text && p.role === 'assistant') addAssistantText(d, o, text);
      }
      // Codex のシェル実行は custom_tool_call（name: "exec"）で、input は
      // tools.exec_command(...) を呼ぶ JavaScript のコード片。**これを解析しない。**
      // 動的に組み立てられた命令まで追おうとすると、塞ぐ面に終端が無くなる。
      // input そのものが「何を実行したか」の記録なので、そのまま残す。
      if (p.type === 'custom_tool_call') {
        d.inputs.push(String(p.input ?? ''));
        d.toolCounts[p.name] = (d.toolCounts[p.name] || 0) + 1;
        d.commands.push({
          at: o.timestamp,
          cmd: digestShell(p.input),
          failed: null, // rollout に exit code が無いので判定できない。false は「成功した」と読まれる
          exit: null,
          output: p.call_id ? outputs.get(p.call_id) : undefined,
        });
      }
      if (p.type === 'function_call') {
        d.inputs.push(String(p.arguments ?? ''));
        d.toolCounts[p.name] = (d.toolCounts[p.name] || 0) + 1;
        let args = {};
        try { args = JSON.parse(p.arguments || '{}'); } catch { /* 引数が読めなくても記録は続ける */ }
        if (args.command) {
          d.commands.push({
            at: o.timestamp,
            cmd: digestShell([].concat(args.command).join(' ')),
            failed: null,
            exit: null,
            output: p.call_id ? outputs.get(p.call_id) : undefined,
          });
        }
        if (args.path || args.file_path) touch(d, args.path || args.file_path, p.name);
      }
    }
  }
  return finish(d);
}

const blank = (host, file) => ({
  host, transcript: file, sessionId: null, cwd: null, branch: null, from: null, to: null,
  messages: [], userMessages: [], notifications: 0, compactions: 0, choices: [], commands: [], files: {}, urls: [], agents: [], toolCounts: {},
  inputs: [],
});
const push = (a, v) => { if (v && !a.includes(v)) a.push(v); };
const addUserText = (d, entry, text) => {
  if (!String(text || '').trim()) return;
  if (fromHuman(entry, text)) {
    const message = { at: entry.timestamp, role: 'human', text };
    d.userMessages.push({ at: message.at, text: message.text });
    d.messages.push(message);
  }
  else d.notifications += 1;
};
const addAssistantText = (d, entry, text) => {
  if (!String(text || '').trim()) return;
  d.messages.push({ at: entry.timestamp, role: 'ai', text });
};
const touch = (d, p, how, edits = 0) => {
  const f = (d.files[p] ||= { path: p, reads: 0, writes: 0, hunks: 0 });
  if (how === 'Read') f.reads++; else { f.writes++; f.hunks += edits; }
};
function finish(d) {
  d.files = Object.values(d.files).sort((a, b) => b.writes - a.writes || a.path.localeCompare(b.path));
  d.failedCommands = d.commands.filter((c) => c.failed === true);
  // 取れなかったものを黙って空で返さない。空配列は「無かった」と読まれる。
  if (d.compactions > 0) {
    d.note = `このセッションは compact を ${d.compactions} 回またいでいる。会話の記憶は要約経由になっているが、`
      + 'transcript には compact 前の全会話が残っているので、この採掘結果のほうが記憶より正確である。';
  }
  d.limitations = d.host === 'codex'
    ? ['コマンドの exit code が rollout に無いため、失敗したコマンドを機械的には特定できない（failed は null）',
       'シェルの命令は tools.exec_command を呼ぶコード片として残るので、cmd はその生の断片になる',
       '参照した URL は取れない。サブエージェントは toolCounts に現れるが、名前までは取れない']
    : [];
  return d;
}

/**
 * 変更されたファイルとコミットは git から取る。
 *
 * transcript のツール呼び出しだけでは足りない。`cat > file` のようにシェル経由で書いた分は
 * ツールの引数に現れず、拾おうとするとシェルの構文解析になる。そこには終端が無いので
 * 踏み込まない（設定リポジトリ README「フックを置く条件」と同じ判断）。
 * git は実際に変わったものを返すので、こちらが正しい情報源になる。
 */
export function gitState(cwd, since) {
  const git = (...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { git('rev-parse', '--git-dir'); } catch { return null; }
  const out = { branch: null, changed: [], commits: [], artifactCandidates: [] };
  try { out.branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* detached HEAD でも続ける */ }
  // 要件定義と設計書は、下の status では足りない。-uall が無いと未追跡の `.mitos/` が 1 行に畳まれ、
  // commit 後は status から消える。作業ツリーとセッション開始以降の commit の両方から候補を取る。
  // `:/` を付けるので、cwd がサブディレクトリでも根から取れる。
  try {
    const status = git('status', '--porcelain', '-uall', '--no-renames', '--', ':/.mitos/changes')
      .split('\n').filter(Boolean).map((l) => l.slice(3));
    const logged = since
      ? git('log', `--since=${since}`, '--format=', '--name-only', '--', ':/.mitos/changes').split('\n').filter(Boolean)
      : [];
    out.artifactCandidates = [...new Set([...status, ...logged])].filter((p) => ARTIFACT.test(p)).sort();
  } catch { /* 取れなくても記録は続ける */ }
  try {
    out.changed = git('status', '--porcelain')
      .split('\n').filter(Boolean)
      .map((l) => ({ state: l.slice(0, 2).trim(), path: l.slice(3) }));
  } catch { /* 取れなくても記録は続ける */ }
  try {
    const args = ['log', '--format=%H|%aI|%s', '--no-merges'];
    if (since) args.push(`--since=${since}`); else args.push('-20');
    out.commits = git(...args).split('\n').filter(Boolean).map((l) => {
      const [sha, at, ...rest] = l.split('|');
      return { sha: sha.slice(0, 7), at, subject: rest.join('|') };
    });
  } catch { /* 同上 */ }
  return out;
}

export function collect(file, host, cwd) {
  const d = host === 'codex' ? collectCodex(file) : collectClaude(file);
  d.git = gitState(cwd || d.cwd || process.cwd(), d.from);
  // **このセッションが触れた成果物だけにする。**git の候補は他のセッションの変更も含むので、
  // tool 呼び出しの入力に path が出るものだけを残す。有限の候補への包含判定で、シェルの構文解析ではない。
  // tool_result は見ない — `git status` の出力に他セッションの成果物が出ただけで結ばれる。
  d.artifacts = (d.git?.artifactCandidates || []).filter((p) => d.inputs.some((s) => s.includes(p)));
  delete d.inputs;
  return d;
}
