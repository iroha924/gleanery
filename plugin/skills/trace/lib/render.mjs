// IR から 2 つの生成物を作る。**どちらも生成物で、手で編集しない。**
//   .html  人間向け。IR を内蔵しているので、これが正本になる
//   .md    AI 向けの投影。次のセッションはこちらを読む（HTML をパースさせない）
//
// 並置は llms.txt v2 と Vercel の Agent Readability spec が推奨している形。
// 同じ IR から両方を出すので、片方だけが古くなることが起きない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, embedJson, IR_ELEMENT_ID } from './ir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arr = (v) => (Array.isArray(v) ? v : []);
const has = (v) => arr(v).length > 0;

const STATUS_LABEL = { planning: '計画中', 'in-progress': '進行中', blocked: '停止中', paused: '中断中', done: '完了' };
const STATUS_CLASS = { planning: 'b-todo', 'in-progress': 'b-doing', blocked: 'b-blocked', paused: 'b-warn', done: 'b-done' };
const KIND_LABEL = { work: '作業', finding: '判明したこと', dead_end: '駄目だった道', debt: '意図して残した負債', state_transition: '状態の変化' };
const WHEN_LABEL = { now: 'いま答えが要る', 'during-implementation': '実装中に解ける', 'out-of-scope': 'この作業の外' };

// 記録は数時間から数日に収まることが多い。全件にフル ISO を書くと、行頭 25 文字が
// 日付の繰り返しになって本文が右へ押し出される。表示は分までにし、機械可読な原文は
// 埋め込んだ IR が持っている。
const short = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const jp = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const evidenceText = (e) => {
  const kind = { command: '$', commit: 'commit', file: 'file', url: 'url', issue: 'issue' }[e.kind] || e.kind;
  const exit = e.exit === undefined || e.exit === null ? '' : ` (exit ${e.exit})`;
  return `${kind} ${e.ref}${exit}`;
};

// --- 依存グラフ。blockedBy を層にして左から右へ並べる ---
function issueGraph(issues) {
  const nodes = issues.filter((i) => i.key);
  if (nodes.length < 2 || !nodes.some((i) => has(i.blockedBy))) return '';
  const keys = new Set(nodes.map((i) => i.key));
  const layer = new Map();
  const depth = (k, seen = new Set()) => {
    if (layer.has(k)) return layer.get(k);
    if (seen.has(k)) return 0; // 循環していても描く。止めない
    seen.add(k);
    const n = nodes.find((i) => i.key === k);
    const deps = arr(n?.blockedBy).filter((d) => keys.has(d));
    const v = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depth(d, seen)));
    layer.set(k, v);
    return v;
  };
  nodes.forEach((n) => depth(n.key));
  const cols = [...new Set([...layer.values()])].sort((a, b) => a - b);
  const W = 168, H = 40, GX = 66, GY = 16;
  const pos = new Map();
  cols.forEach((c) => {
    const inCol = nodes.filter((n) => layer.get(n.key) === c);
    inCol.forEach((n, r) => pos.set(n.key, { x: c * (W + GX), y: r * (H + GY) }));
  });
  const rows = Math.max(...cols.map((c) => nodes.filter((n) => layer.get(n.key) === c).length));
  const width = cols.length * (W + GX) - GX, height = rows * (H + GY) - GY;
  const edges = [];
  for (const n of nodes) {
    for (const d of arr(n.blockedBy).filter((x) => keys.has(x))) {
      const a = pos.get(d), b = pos.get(n.key);
      if (!a || !b) continue;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
      const mx = (x1 + x2) / 2;
      edges.push(`<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="var(--line)" stroke-width="1.5" marker-end="url(#pa)"/>`);
    }
  }
  const boxes = nodes.map((n) => {
    const p = pos.get(n.key);
    const closed = /closed|merged|done/i.test(n.state || '');
    const stroke = closed ? 'var(--ok)' : 'var(--accent)';
    return `<g><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="7" fill="var(--panel)" stroke="${stroke}"/>`
      + `<text x="${p.x + 11}" y="${p.y + 17}" font-size="12" font-family="var(--mono)" fill="var(--ink)">${esc(n.key)}</text>`
      + `<text x="${p.x + 11}" y="${p.y + 31}" font-size="11" fill="var(--dim)">${esc(String(n.title || '').slice(0, 24))}</text></g>`;
  });
  return `<figure style="margin:12px 0"><svg viewBox="-2 -2 ${width + 4} ${height + 4}" width="${width}" role="img" aria-label="issue の依存">`
    + `<defs><marker id="pa" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">`
    + `<path d="M0 0 L8 4 L0 8 z" fill="var(--line)"/></marker></defs>`
    + edges.join('') + boxes.join('') + `</svg>`
    + `<figcaption class="small muted">左が先。矢印の先は、元が終わるまで進めない。</figcaption></figure>`;
}

function bodyHtml(ir) {
  const m = ir.meta, b = ir.background || {}, out = [];
  const s = (x) => esc(x);

  out.push(`<h1>${s(m.title)}</h1>`);
  out.push(`<p class="small muted">${s(m.repo || '')}${m.branch ? ` · <code>${s(m.branch)}</code>` : ''} · 最終更新 ${jp(m.updated)}</p>`);

  out.push(`<div class="hero">`);
  out.push(`<span class="badge ${STATUS_CLASS[m.status] || ''}">${s(STATUS_LABEL[m.status] || m.status)}</span>`);
  out.push(`<p class="goal"><strong>ゴール</strong>: ${s(b.goal)}</p>`);
  if (b.problem) out.push(`<p class="small muted">${s(b.problem)}</p>`);
  if (has(ir.current?.phases)) {
    out.push(`<div class="phases">${arr(ir.current.phases).map((p) =>
      `<div class="phase ${s(p.state)}"><b>${s(p.label)}</b><span class="small muted">${s({ done: '完了', doing: '進行中', blocked: '停止', todo: '未着手' }[p.state] || p.state)}</span></div>`).join('')}</div>`);
  }
  out.push(`<div class="now">`);
  out.push(`<section><h3>いまここ</h3><p>${s(ir.current?.text) || '<span class="empty">未記入</span>'}</p></section>`);
  out.push(`<section><h3>次にやること</h3>${has(ir.next)
    ? `<ol style="margin:0;padding-left:20px">${arr(ir.next).map((n) => `<li>${s(n.text)}${n.who ? ` <span class="small muted">(${s(n.who)})</span>` : ''}</li>`).join('')}</ol>`
    : '<p class="empty">未記入</p>'}</section>`);
  out.push(`</div></div>`);

  // 未解決は空なら節ごと出さない。空欄が残るのが腐り方の実体なので、空欄を作らない。
  if (has(ir.openQuestions)) {
    out.push(`<h2 id="open-questions">未解決の問い</h2><table><thead><tr><th>問い</th><th>誰が答えるか</th><th>いつ</th></tr></thead><tbody>`);
    for (const q of ir.openQuestions) {
      out.push(`<tr id="${s(q.id)}"><td>${q.blocking ? '<span class="badge b-blocked">止まる</span> ' : ''}${s(q.q)}`
        + `<div class="small muted"><code>${s(q.id)}</code></div></td>`
        + `<td>${q.who === 'human' ? '人' : 'AI'}</td><td>${s(WHEN_LABEL[q.when] || q.when)}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  out.push(`<h2 id="background">背景</h2><p>${s(b.problem)}</p>`);
  if (has(b.constraints)) out.push(`<h3>制約</h3><ul>${b.constraints.map((c) => `<li>${s(c)}</li>`).join('')}</ul>`);
  if (has(b.nonGoals)) out.push(`<h3>やらないこと</h3><ul>${b.nonGoals.map((c) => `<li>${s(c)}</li>`).join('')}</ul>`);

  const L = ir.links || {};
  if (has(L.issues) || has(L.prs)) {
    out.push(`<h2 id="links">関連する issue と PR</h2>`);
    if (has(L.issues)) {
      out.push(issueGraph(L.issues));
      out.push(`<table><thead><tr><th>issue</th><th>題</th><th>状態</th><th>本文</th></tr></thead><tbody>`);
      for (const i of L.issues) {
        out.push(`<tr><td>${i.url ? `<a href="${s(i.url)}">${s(i.key || i.url)}</a>` : s(i.key)}</td><td>${s(i.title || '')}</td><td>${s(i.state || '')}</td><td>${i.fetched ? '取得済み' : '<span class="badge b-warn">未取得</span>'}</td></tr>`);
      }
      out.push(`</tbody></table>`);
    }
    if (has(L.prs)) {
      out.push(`<table><thead><tr><th>PR</th><th>題</th><th>状態</th><th>branch</th></tr></thead><tbody>`);
      for (const p of L.prs) {
        out.push(`<tr><td>${p.url ? `<a href="${s(p.url)}">#${s(p.number)}</a>` : `#${s(p.number)}`}</td><td>${s(p.title || '')}</td><td>${s(p.state || '')}</td><td><code>${s(p.branch || '')}</code></td></tr>`);
      }
      out.push(`</tbody></table>`);
    }
  }

  if (has(ir.decisions)) {
    out.push(`<h2 id="decisions">意思決定</h2>`);
    for (const d of ir.decisions) {
      out.push(`<div class="card${d.status === 'superseded' ? ' sup' : ''}" id="${s(d.id)}">`);
      out.push(`<h3>${s(d.decision)}</h3>`);
      // 別の記録を指す参照はこのページにアンカーが無い。リンクにすると必ず切れる。
      const sup = d.supersededBy
        ? (String(d.supersededBy).includes('#')
            ? ` → <code>${s(d.supersededBy)}</code>（別の記録）`
            : ` → <a href="#${s(d.supersededBy)}">${s(d.supersededBy)}</a>`)
        : '';
      out.push(`<p class="small muted"><code>${s(d.id)}</code> · ${jp(d.at)} · ${s(d.status)}${sup}</p>`);
      out.push(`<p>${s(d.context)}</p>`);
      out.push(`<ul class="opts">${arr(d.options).map((o) =>
        `<li class="${o.chosen ? 'chosen' : ''}"><strong>${s(o.option)}</strong>${o.chosen ? '' : ` — ${s(o.whyNot)}`}</li>`).join('')}</ul>`);
      out.push(`<h3 class="small muted" style="margin-top:12px">結果</h3><ul class="cons">${arr(d.consequences).map((c) =>
        `<li class="${c.good === false ? 'bad' : ''}">${s(c.text)}</li>`).join('')}</ul>`);
      const checks = arr(ir.verification).filter((v) => v.verifies === d.id);
      const badge = checks.length === 0
        ? ` <span class="badge b-warn">未検証</span>`
        : checks.map((v) => ` <span class="badge ${v.result === 'pass' ? 'b-done' : v.result === 'fail' ? 'b-blocked' : 'b-warn'}"><a href="#${s(v.id)}">${s(v.id)}</a> ${s(v.result)}</span>`).join('');
      out.push(`<p class="small"><strong>守られていることの確かめ方</strong>: ${s(d.confirmation)}${badge}</p>`);
      if (has(d.evidence)) out.push(`<div class="ev-refs">${d.evidence.map((e) => `<span>${s(evidenceText(e))}</span>`).join('')}</div>`);
      out.push(`</div>`);
    }
  }

  if (has(ir.events)) {
    out.push(`<h2 id="events">経過</h2>`);
    out.push(`<p class="small">${['all', ...Object.keys(KIND_LABEL)].map((k) =>
      `<button data-filter="${k}" aria-pressed="${k === 'all'}">${k === 'all' ? 'すべて' : esc(KIND_LABEL[k])}</button>`).join(' ')}</p>`);
    // 既定の表示は、いまの工程を開いてそれ以前を畳む。**データは削らない。**
    // 件数の閾値は置かない。閾値を決めるには測定が要り、測っていない数を固定すると
    // 後から理由なく格上げされる。工程は記録が自分で持っている境界なので、数を使わずに済む。
    // 止まっている工程も現在地である。doing だけを見ると、blocked のときに畳む基準が消える。
    const cur = arr(ir.current?.phases).find((p) => p.state === 'doing' || p.state === 'blocked')?.id;
    // 各エントリがどの工程で起きたかは、工程の開始時刻から決まる。
    // events[].phase は明示したいときの上書きとしてだけ残す。
    const starts = arr(ir.current?.phases).filter((p) => p.from).sort((a, b2) => String(a.from).localeCompare(String(b2.from)));
    const phaseOf = (e) => {
      if (e.phase) return e.phase;
      let hit = '';
      for (const p of starts) if (String(e.at) >= String(p.from)) hit = p.id;
      return hit;
    };
    const byPhase = new Map();
    for (const e of [...ir.events].sort((a, b2) => String(a.at).localeCompare(String(b2.at)))) {
      const k = phaseOf(e);
      if (!byPhase.has(k)) byPhase.set(k, []);
      byPhase.get(k).push(e);
    }
    let grouped = cur && byPhase.size > 1;
    // 現在の工程にまだエントリが無いことがある（工程を始めた直後）。
    // そのまま畳むと全部閉じた画面になり、いま何が起きているかが 1 つも見えない。
    let openId = cur;
    if (grouped && !byPhase.has(cur)) {
      const keys = [...byPhase.keys()].filter(Boolean);
      openId = keys.length ? keys[keys.length - 1] : '';
    }
    for (const [phaseId, list] of byPhase) {
      const label = arr(ir.current?.phases).find((p) => p.id === phaseId)?.label;
      const openThis = !grouped || phaseId === openId || phaseId === '';
      if (grouped && label) {
        out.push(openThis
          ? `<h3>${s(label)}</h3>`
          : `<details><summary>${s(label)}（${list.length} 件）</summary>`);
      }
      out.push(`<div class="tl">`);
      for (const e of list) {
      out.push(`<div class="ev k-${s(e.kind)}" id="${s(e.id)}">`);
      out.push(`<div class="head"><time>${jp(e.at)}</time><span class="badge ${e.kind === 'dead_end' ? 'b-blocked' : e.kind === 'finding' ? 'b-warn' : 'b-todo'}">${s(KIND_LABEL[e.kind] || e.kind)}</span>`);
      if (e.confidence && e.confidence !== 'fact') out.push(`<span class="conf conf-${s(e.confidence)}">${s(e.confidence)}</span>`);
      out.push(`</div><div>${s(e.text)}</div>`);
      if (has(e.evidence)) out.push(`<div class="ev-refs">${e.evidence.map((x) => `<span>${s(evidenceText(x))}</span>`).join('')}</div>`);
        out.push(`</div>`);
      }
      out.push(`</div>`);
      if (grouped && label && !openThis) out.push(`</details>`);
    }
  }

  if (has(ir.verification)) {
    out.push(`<h2 id="verification">検証</h2><table><thead><tr><th>確かめたこと</th><th>コマンド</th><th>結果</th></tr></thead><tbody>`);
    for (const v of ir.verification) {
      const cls = { pass: 'b-done', fail: 'b-blocked', 'not-run': 'b-warn' }[v.result];
      const how = v.cmd ? `<code>${s(v.cmd)}</code>`
        : has(v.evidence) ? `<span class="small muted">${v.evidence.map((e) => s(evidenceText(e))).join('<br>')}</span>`
        : `<span class="muted">${s(v.whyNotRun)}</span>`;
      out.push(`<tr id="${s(v.id)}"><td>${s(v.what)}<div class="small muted"><code>${s(v.id)}</code></div></td>`
        + `<td>${how}</td><td><span class="badge ${cls}">${s(v.result)}</span></td></tr>`);
      if (v.output) out.push(`<tr><td colspan="3"><details><summary>出力</summary><pre>${s(v.output)}</pre></details></td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  if (has(ir.glossary)) {
    out.push(`<h2 id="glossary">用語</h2><table><thead><tr><th>語</th><th>意味</th></tr></thead><tbody>`);
    for (const g of ir.glossary) out.push(`<tr><td><code>${s(g.term)}</code></td><td>${s(g.meaning)}</td></tr>`);
    out.push(`</tbody></table>`);
  }

  out.push(`<p class="gen">progress-log が生成。正本はこのページに埋め込まれた <code>#${IR_ELEMENT_ID}</code>。`
    + `手で書き換えず、<code>progress</code> を通して追記する。記録したホスト: ${s(arr(m.hosts).join(', '))}</p>`);
  return out.join('\n');
}

function markdown(ir, htmlName, invoke) {
  const m = ir.meta, b = ir.background || {}, o = [];
  const list = (xs, f) => arr(xs).map(f).join('\n');
  o.push(`# ${m.title}`, '');
  o.push(`> ${b.goal || '(ゴール未記入)'}`, '');
  o.push(`- 状態: ${STATUS_LABEL[m.status] || m.status}`);
  o.push(`- 対象: ${m.repo || '-'}${m.branch ? ` (${m.branch})` : ''}`);
  o.push(`- 最終更新: ${m.updated}`);
  o.push(`- 人間向けの表示: \`${htmlName}\``, '');
  o.push(`## いまここ`, '', ir.current?.text || '(未記入)', '');
  // 工程は HTML の工程バーと同じ内容。片方だけに出すと、md を読む側に「どこまで進んだか」が届かない。
  if (has(ir.current?.phases)) {
    const st = { done: '完了', doing: '進行中', blocked: '停止', todo: '未着手' };
    o.push(`### 工程`, '', list(ir.current.phases, (p) => `- ${st[p.state] || p.state}: ${p.label}`), '');
  }
  if (has(ir.next)) o.push(`## 次にやること`, '', list(ir.next, (n) => `- ${n.text}${n.who ? ` (${n.who})` : ''}`), '');
  if (has(ir.openQuestions)) {
    o.push(`## 未解決の問い`, '');
    // 緊急度の符号は 1 つにする。blocking と when を並べると、どちらが強いか読み取れない。
    o.push(list(ir.openQuestions, (q) =>
      `- \`${q.id}\` ${q.blocking ? '**[これが埋まるまで進めない]** ' : ''}${q.q} — 答えるのは ${q.who === 'human' ? '人' : 'AI'} / ${WHEN_LABEL[q.when] || q.when}`), '');
  }
  o.push(`## 背景`, '', b.problem || '(未記入)', '');
  if (has(b.constraints)) o.push(`### 制約`, '', list(b.constraints, (c) => `- ${c}`), '');
  if (has(b.nonGoals)) o.push(`### やらないこと`, '', list(b.nonGoals, (c) => `- ${c}`), '');
  const L = ir.links || {};
  if (has(L.issues) || has(L.prs)) {
    o.push(`## 関連`, '');
    if (has(L.issues)) o.push(list(L.issues, (i) => `- issue ${i.key || ''} ${i.title || ''} [${i.state || '?'}]${i.fetched ? '' : ' (本文は未取得)'}${i.url ? ` ${i.url}` : ''}${has(i.blockedBy) ? ` blocked-by: ${i.blockedBy.join(', ')}` : ''}`), '');
    if (has(L.prs)) o.push(list(L.prs, (p) => `- PR #${p.number} ${p.title || ''} [${p.state || '?'}]${p.url ? ` ${p.url}` : ''}`), '');
  }
  if (has(ir.decisions)) {
    o.push(`## 意思決定`, '');
    for (const d of ir.decisions) {
      // 見出しは ID だけにする。1 文まるごとの見出しは目次にも一覧にも使えない。
      o.push(`### ${d.id}`, '');
      o.push(`**${d.decision}**`, '');
      o.push(`- 状態: ${d.status}${d.supersededBy ? ` (→ ${d.supersededBy}${String(d.supersededBy).includes('#') ? '、別の記録' : ''})` : ''} / ${short(d.at)}`);
      o.push(`- 文脈: ${d.context}`);
      o.push(`- 検討した案:`);
      o.push(list(d.options, (x) => `  - ${x.chosen ? '採用' : '棄却'}: ${x.option}${x.chosen ? '' : ` — ${x.whyNot}`}`));
      o.push(`- 結果:`);
      o.push(list(d.consequences, (c) => `  - ${c.good === false ? '(不利) ' : ''}${c.text}`));
      const ck = arr(ir.verification).filter((v) => v.verifies === d.id);
      o.push(`- 守られていることの確かめ方: ${d.confirmation}`);
      o.push(`- 検証: ${ck.length ? ck.map((v) => `${v.id} [${v.result}]`).join(' / ') : '**未検証**'}`);
      if (has(d.evidence)) o.push(`- 根拠: ${d.evidence.map(evidenceText).join(' / ')}`);
      o.push('');
    }
  }
  if (has(ir.events)) {
    o.push(`## 経過`, '');
    for (const e of [...ir.events].sort((a, b2) => String(a.at).localeCompare(String(b2.at)))) {
      const conf = e.confidence && e.confidence !== 'fact' ? ` [${e.confidence}]` : '';
      o.push(`- \`${e.id}\` ${short(e.at)} [${KIND_LABEL[e.kind] || e.kind}]${conf} ${e.text}${has(e.evidence) ? ` — ${e.evidence.map(evidenceText).join(' / ')}` : ''}`);
    }
    o.push('');
  }
  if (has(ir.verification)) {
    o.push(`## 検証`, '');
    o.push(list(ir.verification, (v) => {
      const how = v.cmd ? ` — \`${v.cmd}\`` : has(v.evidence) ? ` — ${v.evidence.map(evidenceText).join(' / ')}` : '';
      const of = v.verifies ? ` （${v.verifies} を確かめた）` : '';
      return `- \`${v.id}\` [${v.result}] ${v.what}${of}${how}${v.result === 'not-run' ? ` (未実行: ${v.whyNotRun})` : ''}`;
    }), '');
  }
  if (has(ir.glossary)) {
    o.push(`## 用語`, '');
    o.push(list(ir.glossary, (g) => `- ${g.term}: ${g.meaning}`), '');
  }
  o.push(`## この文書について`, '');
  o.push(`\`${htmlName}\` から生成された投影で、手で編集しても次の書き出しで消える。`);
  // 呼び出し方は実際に走った CLI のパスを書く。素の `progress` は PATH に無く、
  // 相対パスは Claude Code の cwd では当たらない（読み手が 2 回空振りした）。
  o.push(`書き換えるときは IR を取り出して直し、描き直す。`);
  o.push(`\`node ${invoke} read ${htmlName} > ir.json\` → 編集 → \`node ${invoke} render ir.json\`。`);
  return o.join('\n') + '\n';
}

export function render(ir, htmlPath, invoke = 'bin/progress.mjs') {
  const tpl = fs.readFileSync(path.join(ROOT, 'assets/template.html'), 'utf8');
  const html = tpl
    .replace('__TITLE__', () => esc(ir.meta.title))
    .replace('__IR__', () => embedJson(ir))
    .replace('__BODY__', () => bodyHtml(ir));
  const mdPath = htmlPath.replace(/\.html$/, '.md');
  // 実ファイル名を渡す。meta.id から組み立てると、接尾辞が変わったときに
  // 存在しないファイル名を書いてしまう（実測: <id>.html と書いたが実体は <id>.progress.html）。
  const md = markdown(ir, path.basename(htmlPath), invoke);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(mdPath, md);
  return { htmlPath, mdPath, bytes: Buffer.byteLength(html), mdBytes: Buffer.byteLength(md) };
}

/**
 * 再開する側（Claude / Codex）へ渡す要約。**文書の順ではなく、行動の順に並べる。**
 *
 * .md は記録として読む順（背景 → 経過 → 検証）で書かれているが、再開するときに要るのは
 * 「次に何をするか」と「何をしてはいけないか」で、それが真ん中にあると拾われない
 * （Lost in the Middle / context rot）。だから先頭へ寄せ直す。
 */
export function briefing(ir, files = {}) {
  // invoke は呼び出し側（CLI）が渡す実際のパス。ここで組み立てると、
  // ホストによって当たらない相対パスを埋め込むことになる。
  const invoke = files.invoke || 'bin/progress.mjs';
  const m = ir.meta, b = ir.background || {}, o = [];
  const list = (xs, f) => arr(xs).map(f).filter(Boolean).join('\n');

  o.push(`# 再開: ${m.title}`, '');
  o.push(`状態 ${STATUS_LABEL[m.status] || m.status} / 最終更新 ${m.updated} / ${m.repo || '-'}${m.branch ? ` (${m.branch})` : ''}`, '');
  o.push(`## ゴール`, '', b.goal || '(未記入)', '');

  const blockingCount = arr(ir.openQuestions).filter((q) => q.blocking).length;
  o.push(blockingCount > 0
    ? `**まだ未知が残っている。**答えの出ていない問いが ${blockingCount} 件あり、先にそれを潰さないと手戻りになる。`
    : `**未知は残っていない。**止まっている問いは無いので、下の順に進めてよい。`, '');
  o.push(`## 次にやること`, '');
  o.push(has(ir.next) ? list(ir.next, (n, i) => `${i + 1}. ${n.text}${n.who ? ` — ${n.who === 'human' ? '人の判断が要る' : 'AI が進めてよい'}` : ''}`) : '(未記入)');
  o.push('');

  // ここが再開時に一番効く。同じ道を二度通らせないための節。
  const ng = [];
  for (const x of arr(b.nonGoals)) ng.push(`- やらない: ${x}`);
  for (const x of arr(b.constraints)) ng.push(`- 制約: ${x}`);
  for (const e of arr(ir.events).filter((x) => x.kind === 'dead_end')) {
    ng.push(`- 通って駄目だった: ${e.text}${has(e.evidence) ? ` [${e.evidence.map(evidenceText).join(' / ')}]` : ''}`);
  }
  for (const e of arr(ir.events).filter((x) => x.kind === 'debt')) {
    ng.push(`- 意図して残している（欠陥ではないので直しにいかない）: ${e.text}`);
  }
  for (const d of arr(ir.decisions).filter((x) => x.status === 'superseded')) {
    ng.push(`- 一度採って覆した: ${d.decision}（${d.supersededBy} に置き換わった）`);
  }
  // 棄却した案は**名前と参照先だけ**にする。再開する側が要るのは「これを再提案しない」で、
  // 理由の全文は棄却を覆したくなったときにしか要らない。全文を載せると、決定が増えるほど
  // 要約が全文へ近づく（実測: 決定 10 件で棄却理由が 1,363 トークン、要約全体の 19%）。
  for (const d of arr(ir.decisions).filter((x) => x.status === 'accepted')) {
    const rejected = arr(d.options).filter((x) => x.chosen !== true).map((x) => x.option);
    if (rejected.length) ng.push(`- 検討して棄却済み: ${rejected.join(' / ')}（理由は ${d.id}）`);
  }
  if (ng.length) { o.push(`## 通ってはいけない道`, '', ng.join('\n'), ''); }

  const blocking = arr(ir.openQuestions).filter((q) => q.blocking);
  if (blocking.length) {
    o.push(`## いま止まっている問い`, '');
    o.push(list(blocking, (q) => `- ${q.q} — 答えられるのは ${q.who === 'human' ? '人' : 'AI'}`), '');
  }

  const live = arr(ir.decisions).filter((d) => d.status === 'accepted');
  if (live.length) {
    o.push(`## 決まっていること`, '');
    // 受け入れた不利な点は残す（再開した側がそれを欠陥と誤認しないため）。
    // 確かめ方は作業を終えるときに要るもので、再開の入口では参照先で足りる。
    for (const d of live) {
      o.push(`- **${d.decision}**（${d.id}）`);
      const bad = arr(d.consequences).filter((c) => c.good === false);
      if (bad.length) o.push(`  - 受け入れた不利な点: ${bad.map((c) => c.text).join(' / ')}`);
    }
    o.push('', `決定の文脈・棄却理由・確かめ方は ${files.md || `${m.id}.md`} の「意思決定」節にある。`);
    o.push('');
  }

  o.push(`## 直前の状態`, '', ir.current?.text || '(未記入)', '');

  const findings = arr(ir.events).filter((e) => e.kind === 'finding').slice(-6);
  if (findings.length) {
    o.push(`## 判明していること`, '');
    o.push(list(findings, (e) => `- ${e.text}${e.confidence && e.confidence !== 'fact' ? ` [${e.confidence}]` : ''}`), '');
  }

  if (has(ir.verification)) {
    o.push(`## 検証`, '');
    o.push(list(ir.verification, (v) => `- [${v.result}] ${v.what}${v.cmd ? ` \`${v.cmd}\`` : ''}${v.result === 'not-run' ? ` — 未実行: ${v.whyNotRun}` : ''}`), '');
  }

  const L = ir.links || {};
  if (has(L.issues) || has(L.prs)) {
    o.push(`## 関連`, '');
    o.push(list(L.issues, (i) => `- issue ${i.key} [${i.state || '?'}] ${i.title || ''}${i.fetched ? '' : ' (本文は未取得)'}`));
    o.push(list(L.prs, (p) => `- PR #${p.number} [${p.state || '?'}] ${p.title || ''}`));
    o.push('');
  }
  if (has(ir.glossary)) {
    o.push(`## 用語`, '', list(ir.glossary, (g) => `- ${g.term}: ${g.meaning}`), '');
  }

  const html = files.html || `${m.id}.html`;
  const md = files.md || html.replace(/\.html$/, '.md');
  o.push(`---`, '');
  o.push(`全文が要るときに読む: ${md}`);
  o.push(`（同じ内容の ${html} は人間向けの表示なので読まない。中身は同じで、HTML のぶんだけ長い）`);
  o.push(`追記するとき: node ${invoke} read ${html} > ir.json`);
  return o.join('\n') + '\n';
}
