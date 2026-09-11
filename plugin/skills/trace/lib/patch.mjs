// IR へ変更を当てる。**エージェントが書くのはコードではなくデータ**にするためにある。
//
// これが無かった間、記録を直すたびにその場で書き捨ての JavaScript / Python を作って走らせていた。
// **実測（2026-09-09）: そのうち 1 本が SyntaxError で落ち、ファイルを書かないまま
// 後続の validate と ingest が古い内容に対して走り、成功と報告された。**
// 書き捨てのコードは毎回まっさらで、テストも無く、失敗が終了コードに出ない。
//
// **契約はここで機構にする。**SKILL.md が散文で書いていた制約を、当てる側が拒否する。
//   - 追記してよいのは events / decisions / verification / openQuestions だけ
//   - id は再利用しない（既にある id への append は拒否）
//   - 上書きしてよいのは current / next / openQuestions / knowledge / meta.updated だけ
//     （events / decisions / verification は過去を書き換えない）

const APPENDABLE = ['events', 'decisions', 'verification', 'openQuestions'];
const SETTABLE = ['current', 'next', 'openQuestions', 'knowledge', 'meta'];
const TOP = ['append', 'set', 'supersede'];

const arr = (x) => (Array.isArray(x) ? x : []);

/**
 * @param {object} ir    取り込み前の IR（破壊しない。新しいオブジェクトを返す）
 * @param {object} patch 当てる内容
 * @returns {{ ok: boolean, ir: object, changes: string[], problems: {code: string, message: string, fix: string}[] }}
 */
export function applyPatch(ir, patch) {
  const problems = [];
  const changes = [];
  const P = (code, message, fix) => problems.push({ code, message, fix });
  const out = structuredClone(ir);

  for (const k of Object.keys(patch ?? {})) {
    if (!TOP.includes(k)) P('patch/unknown-key', `知らない欄: "${k}"`, `使えるのは ${TOP.join(' / ')}`);
  }

  // **同じ欄へ append と set を同時に来させない。**set は丸ごと置き換えるので、
  // 順に当てると append が黙って消える。**そのうえで「当てた」と報告される** —
  // このコマンドが無くすために作られた失敗の形そのものなので、ここで止める。
  for (const k of Object.keys(patch?.append ?? {})) {
    if (k in (patch?.set ?? {})) {
      P('patch/append-and-set', `"${k}" に append と set が両方ある。set が丸ごと置き換えるので append が消える。`,
        'どちらか一方にする。既存を残して足すなら append だけを使う');
    }
  }

  // --- append ---------------------------------------------------------------
  // 既にある id を弾く。**再取り込みで上書きするのと、記録へ足すのは別の操作**で、
  // 前者は ingest がやる。ここで通すと、過去の要素を黙って書き換える道になる。
  const ids = new Set();
  for (const field of APPENDABLE) for (const x of arr(out[field])) if (x?.id) ids.add(x.id);

  for (const [field, items] of Object.entries(patch?.append ?? {})) {
    if (!APPENDABLE.includes(field)) {
      P('patch/not-appendable', `"${field}" へは追記できない。`, `追記できるのは ${APPENDABLE.join(' / ')}`);
      continue;
    }
    if (!Array.isArray(items)) {
      P('patch/append-not-array', `append.${field} が配列ではない。`, '要素の配列を渡す');
      continue;
    }
    for (const x of items) {
      if (!x || typeof x !== 'object') { P('patch/append-not-object', `append.${field} にオブジェクトでない要素がある。`, '要素はオブジェクトにする'); continue; }
      if (!x.id) { P('patch/append-no-id', `append.${field} の要素に id が無い。`, 'id を付ける'); continue; }
      if (!x.at) { P('patch/append-no-at', `"${x.id}" に観測時点（at）が無い。`, 'ISO 8601 の at を付ける'); continue; }
      if (ids.has(x.id)) {
        P('patch/append-duplicate-id', `"${x.id}" は既にある。id は再利用しない。`,
          '別の id にする。過去の要素を直したいなら、直す理由ごと新しい要素として足す');
        continue;
      }
      ids.add(x.id);
      out[field] = [...arr(out[field]), x];
      changes.push(`append ${field}: ${x.id}`);
    }
  }

  // --- set ------------------------------------------------------------------
  for (const [field, value] of Object.entries(patch?.set ?? {})) {
    if (!SETTABLE.includes(field)) {
      P('patch/not-settable', `"${field}" は上書きできない。`,
        `上書きしてよいのは ${SETTABLE.join(' / ')}。過去の要素は書き換えず append で足す`);
      continue;
    }
    if (field === 'meta') {
      // meta の中でも触ってよいのは updated だけ。id や repo が動くと別の記録になる。
      for (const k of Object.keys(value ?? {})) {
        if (k !== 'updated') { P('patch/meta-locked', `meta.${k} は書き換えられない。`, '触ってよいのは meta.updated だけ'); continue; }
        out.meta = { ...out.meta, updated: value.updated };
        changes.push(`set meta.updated: ${value.updated}`);
      }
      continue;
    }
    // **形を見ないと `set: {current: null}` が通る。**現在地が消えた記録は
    // `current_work` から見えなくなり、しかも「当てた」と報告される。
    if (value === null || value === undefined) {
      P('patch/set-empty', `set.${field} が空。`, '値を渡す。消したいなら空の配列かオブジェクトを明示する');
      continue;
    }
    if ((field === 'next' || field === 'openQuestions' || field === 'knowledge') && !Array.isArray(value)) {
      P('patch/set-not-array', `set.${field} は配列でなければならない。`, '配列を渡す');
      continue;
    }
    if (field === 'current' && (Array.isArray(value) || typeof value !== 'object')) {
      P('patch/set-not-object', 'set.current はオブジェクトでなければならない。', '{ at, text } の形で渡す');
      continue;
    }
    out[field] = value;
    changes.push(`set ${field}`);
  }

  // --- supersede ------------------------------------------------------------
  // 覆した決定に印を付ける。**status だけ変えて supersededBy を忘れる**のを防ぐため、
  // 2 つを 1 つの操作にしてある（validate も supersededBy の無い superseded を弾く）。
  for (const [oldId, newId] of Object.entries(patch?.supersede ?? {})) {
    const target = arr(out.decisions).find((d) => d.id === oldId);
    if (!target) { P('patch/supersede-missing', `覆される決定が無い: "${oldId}"`, 'decisions にある id を指す'); continue; }
    if (oldId === newId) {
      // 自分で自分を覆すと、status は superseded になるのに何にも置き換わっていない。
      // validate は通り、取り込みでは極性だけが dont に落ちて、決定が黙って死ぬ。
      P('patch/supersede-self', `"${oldId}" が自分自身を覆している。`, '覆した側の別の決定を指す');
      continue;
    }
    if (!arr(out.decisions).some((d) => d.id === newId)) {
      P('patch/supersede-missing-new', `覆す側の決定が無い: "${newId}"`, '先に append で足すか、既にある id を指す');
      continue;
    }
    target.status = 'superseded';
    target.supersededBy = newId;
    changes.push(`supersede ${oldId} -> ${newId}`);
  }

  return { ok: problems.length === 0, ir: out, changes, problems };
}
