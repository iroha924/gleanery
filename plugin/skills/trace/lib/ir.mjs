// IR の形と検査。**正本はこのファイルで、HTML も Markdown もここから生成される。**
//
// 検査は「文章の質」を測らない。測るのは構造上の契約だけで、質は SKILL.md の基準と
// レビューが担う（skills/writing-quality が同じ判断をしている）。
// 語彙の辞書は置かない。「抽象語らしさ」を機械で測った実測データを持っていないので、
// 持っていない検査を閾値付きで入れない。代わりに構造で強制する
// （棄却理由が無ければ decisions は通らない、など）。

import { SESSION_SCHEMA, sessionRecordId } from './session.mjs';

export const SCHEMA = SESSION_SCHEMA;
const LEGACY_SCHEMA = 'progress/1';

export const STATUS = ['planning', 'in-progress', 'blocked', 'paused', 'done'];
export const EVENT_KINDS = ['work', 'finding', 'dead_end', 'debt', 'state_transition'];
export const DECISION_STATUS = ['proposed', 'accepted', 'rejected', 'superseded'];
export const CONFIDENCE = ['fact', 'inference', 'opinion'];
export const QUESTION_WHEN = ['now', 'during-implementation', 'out-of-scope'];
export const VERIFY_RESULT = ['pass', 'fail', 'not-run'];

// 意味のある語だけを id に許す。UUID や連番は retrieval の精度を落とす
// （Anthropic "Writing tools for agents": 意味のある識別子へ解決するとハルシネーションが減る）。
const ID = /^[a-z0-9][a-z0-9-]*$/;
// 記録をまたぐ参照。`<記録の id>#<要素の id>` で書く。`#` が無ければ同じ記録の中を指す。
// これが無いと「3 か月前の別作業の決定をいま覆した」が書けない。
const REF = /^[a-z0-9][a-z0-9-]*(#[a-z0-9][a-z0-9-]*)?$/;
const isLocalRef = (r) => typeof r === 'string' && !r.includes('#');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const arr = (v) => (Array.isArray(v) ? v : []);

// **知らない欄は名前を挙げて弾く。**黙って捨てると、書き手は「書いたのに効かない」ではなく
// 「別の欄が足りない」という誤った症状だけを受け取る（実測: verification に `how` と書いた 8 件が、
// 「コマンドも証跡も無い」としか報告されなかった）。手書きの JSON は検査器にとっての入力なので、
// ここは信頼境界であり、起こり得ないケースへの防御ではない。
const KEYS = {
  events: ['id', 'at', 'kind', 'text', 'confidence', 'evidence', 'phase'],
  decisions: ['id', 'at', 'status', 'context', 'decision', 'options', 'consequences', 'confirmation', 'evidence', 'supersededBy'],
  verification: ['id', 'at', 'what', 'cmd', 'result', 'output', 'evidence', 'verifies', 'note', 'whyNotRun'],
  openQuestions: ['id', 'at', 'q', 'who', 'when', 'blocking'],
};

/**
 * 契約違反（problems）と、埋まっていない推奨欄（warnings）を分けて返す。
 * problems は exit 1、warnings は exit 0。意図的に空にすることがある欄で
 * 落とすと、書き手は形だけ埋めるようになる。
 */
export function validate(ir) {
  const problems = [];
  const warnings = [];
  const P = (code, message, fix) => problems.push({ code, message, fix });
  const W = (code, message, fix) => warnings.push({ code, message, fix });

  if (ir?.schema !== SCHEMA && ir?.schema !== LEGACY_SCHEMA) {
    P('schema/unknown', `schema が "${SCHEMA}" でない: ${JSON.stringify(ir?.schema)}`, `schema を "${SCHEMA}" にする`);
    return { ok: false, problems, warnings };
  }

  const m = ir.meta || {};
  if (!ID.test(m.id || '')) P('meta/id', `meta.id が意味のある語でない: ${JSON.stringify(m.id)}`, '英小文字・数字・ハイフンで、内容が分かる語にする');
  if (!isStr(m.title)) P('meta/title', 'meta.title が空。', '何の作業かが分かる題を書く');
  if (!STATUS.includes(m.status)) P('meta/status', `meta.status が ${STATUS.join(' / ')} のどれでもない: ${JSON.stringify(m.status)}`, 'いずれかにする');
  for (const f of ['created', 'updated']) {
    if (!ISO.test(m[f] || '')) P(`meta/${f}`, `meta.${f} が ISO 8601 でない: ${JSON.stringify(m[f])}`, '観測時点が無いと、いつ真だった話か分からなくなる');
  }

  if (ir.schema === SCHEMA) {
    const s = ir.session || {};
    if (!isStr(s.id)) P('session/id', 'session.id が空。', '元ツールのセッション ID を残す');
    if (!['claude-code', 'codex'].includes(s.host)) {
      P('session/host', `session.host が claude-code / codex のどちらでもない: ${JSON.stringify(s.host)}`, '元ツールを指定する');
    }
    if (isStr(s.id) && isStr(s.host) && m.id !== sessionRecordId(s.host, s.id)) {
      P('session/record-id', `meta.id がセッション ID から決まる値ではない: ${JSON.stringify(m.id)}`, `meta.id を ${sessionRecordId(s.host, s.id)} にする`);
    }
    const utterances = arr(ir.utterances);
    if (utterances.length === 0) P('session/utterances', 'utterances が空。', 'collect と sessionize をやり直す');
    const utteranceKeys = new Set();
    for (const u of utterances) {
      if (!ID.test(u.key || '')) P('session/utterance-key', `発言の key が不正: ${JSON.stringify(u.key)}`, 'sessionize で作り直す');
      else if (utteranceKeys.has(u.key)) P('session/utterance-duplicate', `発言の key が重複している: ${u.key}`, 'sessionize で作り直す');
      else utteranceKeys.add(u.key);
      if (!ISO.test(u.at || '')) P('session/utterance-at', `発言の at が ISO 8601 でない: ${JSON.stringify(u.at)}`, 'sessionize で作り直す');
      if (!['human', 'ai'].includes(u.role)) P('session/utterance-role', `発言の role が human / ai でない: ${JSON.stringify(u.role)}`, 'sessionize で作り直す');
      if (!isStr(u.text)) P('session/utterance-text', `発言 ${JSON.stringify(u.key)} の text が空。`, 'sessionize で作り直す');
    }
  }

  const b = ir.background || {};
  if (!isStr(b.problem)) P('background/problem', 'background.problem が空。', 'なぜこの作業が必要になったかを書く');
  if (!isStr(b.goal)) P('background/goal', 'background.goal が空。', '達成を測れる形で書く（「動くようにする」ではなく観測できる条件）');
  if (arr(b.nonGoals).length === 0) W('background/non-goals', 'background.nonGoals が空。', '境界が無いと、再開した側が勝手に範囲を広げる');

  // current は「上書きしてよい 3 つ」の筆頭で、再開時の要約の「直前の状態」の供給元。
  // ここが空のまま出荷されると、再開に一番効く欄が無い記録になる。
  const cur = ir.current || {};
  // 工程に開始時刻を持たせると、events の phase を宣言させずに時刻から導出できる。
  // 宣言欄は書かれずに腐る（実測: events 34 件中 phase 記入 0 件で、折りたたみが一度も発火しなかった）。
  for (const ph of arr(cur.phases)) {
    if (ph.from !== undefined && !ISO.test(ph.from)) {
      P('current/phase-from', `phases "${ph.id}" の from が ISO 8601 でない: ${JSON.stringify(ph.from)}`, 'その工程がいつ始まったかを持たせる。省略してもよいが、書くなら ISO 8601');
    }
  }
  if (!ISO.test(cur.at || '')) P('current/at', `current.at が ISO 8601 でない: ${JSON.stringify(cur.at)}`, 'いまの状態をいつ書いたかを持たせる');
  if (!isStr(cur.text)) P('current/text', 'current.text が空。', '何が終わっていて何が動いているかを書く。再開する側が最初に読む欄');

  const seen = new Map();
  const uniq = (id, where) => {
    if (!ID.test(id || '')) { P(`${where}/id`, `${where} の id が意味のある語でない: ${JSON.stringify(id)}`, '英小文字・数字・ハイフンにする'); return; }
    if (seen.has(id)) P(`${where}/id-duplicate`, `id が重複している: ${id}（${seen.get(id)} と ${where}）`, 'id は再利用しない');
    else seen.set(id, where);
  };
  const at = (o, where) => {
    if (!ISO.test(o.at || '')) P(`${where}/at`, `${where} の at が ISO 8601 でない: ${JSON.stringify(o.at)}`, '観測時点を必ず持たせる');
  };
  const known = (o, where) => {
    const bad = Object.keys(o).filter((k) => !KEYS[where].includes(k));
    if (bad.length) P(`${where}/unknown-key`, `${where} "${o.id}" に無い欄がある: ${bad.join(' / ')}`, `使えるのは ${KEYS[where].join(' / ')}`);
  };

  for (const e of arr(ir.events)) {
    uniq(e.id, 'events');
    at(e, 'events');
    known(e, 'events');
    if (!EVENT_KINDS.includes(e.kind)) P('events/kind', `events.kind が ${EVENT_KINDS.join(' / ')} のどれでもない: ${JSON.stringify(e.kind)}`, 'いずれかにする');
    if (!isStr(e.text)) P('events/text', `events "${e.id}" の text が空。`, '何が起きたかを書く');
    if (e.confidence !== undefined && !CONFIDENCE.includes(e.confidence)) P('events/confidence', `events "${e.id}" の confidence が不正: ${JSON.stringify(e.confidence)}`, `${CONFIDENCE.join(' / ')} のいずれかにする`);
    // 中核の契約。fact を名乗るなら根拠が要る。
    // これが無いと全件が fact になって印が形骸化する（"unverifiable inference"）。
    if (e.confidence === 'fact' && arr(e.evidence).length === 0) {
      P('events/fact-without-evidence', `events "${e.id}" が fact だが evidence が無い。`, 'コマンドと exit code・コミット・ファイル・URL のいずれかを添えるか、confidence を inference にする');
    }
  }

  for (const d of arr(ir.decisions)) {
    uniq(d.id, 'decisions');
    at(d, 'decisions');
    known(d, 'decisions');
    if (!DECISION_STATUS.includes(d.status)) P('decisions/status', `decisions "${d.id}" の status が不正: ${JSON.stringify(d.status)}`, DECISION_STATUS.join(' / '));
    for (const f of ['context', 'decision', 'confirmation']) {
      if (!isStr(d[f])) P(`decisions/${f}`, `decisions "${d.id}" の ${f} が空。`, f === 'confirmation' ? 'この決定が守られていることをどう確かめるかを書く' : '埋める');
    }
    // 決定の価値は捨てた案にある。棄却理由の無い「決定」は決定ではない。
    const opts = arr(d.options);
    if (opts.length === 0) P('decisions/options', `decisions "${d.id}" に検討した案が無い。`, '棄却した案と、棄却した理由を書く');
    for (const o of opts) {
      if (!isStr(o.option)) P('decisions/option-empty', `decisions "${d.id}" の案に中身が無い。`, '案の名前を書く');
      else if (o.chosen !== true && !isStr(o.whyNot)) P('decisions/why-not', `decisions "${d.id}" の案 "${o.option}" に棄却理由が無い。`, 'なぜ採らなかったかを書く');
    }
    if (!opts.some((o) => o.chosen === true)) P('decisions/no-chosen', `decisions "${d.id}" に採用した案の印が無い。`, '採った案に chosen: true を付ける');
    const cons = arr(d.consequences);
    if (cons.length === 0) P('decisions/consequences', `decisions "${d.id}" に結果が無い。`, '決定を適用した後どうなるかを書く');
    // Nygard 原典: "All consequences should be listed here, not just the positive ones"
    else if (cons.every((c) => c.good !== false)) W('decisions/only-good', `decisions "${d.id}" の結果が良いものだけ。`, '受け入れた不利な点も書く。無いなら無いと確かめる');
    if (d.status === 'superseded' && !isStr(d.supersededBy)) P('decisions/superseded-by', `decisions "${d.id}" が superseded だが後続への指定が無い。`, 'supersededBy に後続の id を書く。別の記録なら <記録の id>#<決定の id>');
    else if (isStr(d.supersededBy) && !REF.test(d.supersededBy)) P('decisions/superseded-by-form', `decisions "${d.id}" の supersededBy が参照の形でない: ${JSON.stringify(d.supersededBy)}`, '同じ記録なら d-xxx、別の記録なら <記録の id>#d-xxx');
  }

  for (const q of arr(ir.openQuestions)) {
    uniq(q.id, 'openQuestions');
    at(q, 'openQuestions');
    known(q, 'openQuestions');
    if (!isStr(q.q)) P('questions/q', `openQuestions "${q.id}" が空。`, '問いを書く');
    if (!['human', 'ai'].includes(q.who)) P('questions/who', `openQuestions "${q.id}" の who が human / ai でない。`, '誰が答えられるかを決める');
    if (!QUESTION_WHEN.includes(q.when)) P('questions/when', `openQuestions "${q.id}" の when が不正。`, QUESTION_WHEN.join(' / '));
  }

  const ver = arr(ir.verification);
  for (const v of ver) {
    uniq(v.id, 'verification');
    at(v, 'verification');
    known(v, 'verification');
    if (!isStr(v.what)) P('verification/what', `verification "${v.id}" の what が空。`, '何を確かめたのかを書く');
    if (!VERIFY_RESULT.includes(v.result)) P('verification/result', `verification "${v.id}" の result が不正。`, VERIFY_RESULT.join(' / '));
    // 検証はコマンドとは限らない。別のエージェントへのレビュー依頼も、ブラウザでの目視も
    // 実在する検証で、結果もある。要るのは「通ったはず」と「通った」を区別できる指し先で、
    // それはコマンドか証跡のどちらかで足りる。cmd を必須にすると、散文がコマンド欄へ入る。
    if (v.result !== 'not-run' && !isStr(v.cmd) && arr(v.evidence).length === 0) {
      P('verification/no-cmd-or-evidence', `verification "${v.id}" に、実行したコマンドも証跡も無い。`, '`cmd` に実行したコマンドを書くか、`evidence` にレポートやログのパスを入れる');
    }
    // **`#` が入っていれば検査が 1 つも走らない状態だった**（実測: `"ゴミ !!!#hello world"` が exit 0）。
    // 隣の supersededBy は形式と存在の両方を見ている。非対称を対称にする。
    if (isStr(v.verifies) && !REF.test(v.verifies)) P('verification/verifies-form', `verification "${v.id}" の verifies が参照の形でない: ${JSON.stringify(v.verifies)}`, '同じ記録なら d-xxx、別の記録なら <記録の id>#d-xxx');
    if (v.result === 'not-run' && !isStr(v.whyNotRun)) P('verification/why-not-run', `verification "${v.id}" が not-run だが理由が無い。`, '環境が無い・別 OS が要る等、実行しなかった理由を書く');
  }
  if (ver.length === 0) W('verification/empty', 'verification が空。', '実行した検証と、実行しなかったものを残す');

  for (const i of arr(ir.links?.issues)) {
    if (!isStr(i.key) && !isStr(i.url)) P('links/issue', 'issue に key も url も無い。', '取得できなくても、せめて識別子は残す');
    if (i.fetched !== true && i.fetched !== false) P('links/issue-fetched', `issue "${i.key || i.url}" の fetched が真偽値でない。`, '本文を取得できたかを true / false で記録する');
  }

  // 同じ記録の中を指しているのに、その id が無いものは壊れた参照。
  const decisionIds = new Set(arr(ir.decisions).map((d) => d.id));
  for (const d of arr(ir.decisions)) {
    if (isLocalRef(d.supersededBy) && !decisionIds.has(d.supersededBy)) {
      P('decisions/superseded-by-missing', `decisions "${d.id}" の supersededBy "${d.supersededBy}" がこの記録に無い。`, '別の記録を指すなら <記録の id>#${d.supersededBy} と書く');
    }
  }
  for (const v of ver) {
    if (isLocalRef(v.verifies) && !decisionIds.has(v.verifies)) {
      P('verification/verifies-missing', `verification "${v.id}" の verifies "${v.verifies}" が、この記録の decisions に無い。`, 'verifies は decisions の id だけを指す。events を指したいなら evidence に書く。別の記録の決定なら <記録の id>#d-xxx');
    }
  }
  // 「守ると決めたのに一度も確かめていない決定」。DB へ入れるとリポジトリ横断で引ける。
  const verified = new Set(ver.map((v) => v.verifies).filter(Boolean));
  const unverified = arr(ir.decisions).filter((d) => d.status === 'accepted' && isStr(d.confirmation) && !verified.has(d.id));
  if (unverified.length > 0) {
    W('decisions/unverified', `確かめ方を書いたのに検証と結び付いていない決定が ${unverified.length} 件（${unverified.map((d) => d.id).join(', ')}）。`, 'verification に verifies: <決定の id> を足す。まだ確かめていないなら result: not-run で理由を書く');
  }

  if (arr(ir.glossary).length === 0) W('glossary/empty', 'glossary が空。', '前提を知らない読み手向けに、プロジェクト固有語を残す');
  if (!arr(ir.events).some((e) => e.kind === 'dead_end')) W('events/no-dead-end', '試して駄目だったことが 1 件も無い。', '本当に無かったなら問題ない。あったのに書いていないなら、次の人が同じ道を通る');

  return { ok: problems.length === 0, problems, warnings };
}

// --- HTML への埋め込みと取り出し ---
