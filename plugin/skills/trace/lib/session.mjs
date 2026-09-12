import crypto from 'node:crypto';

export const SESSION_SCHEMA = 'session/3';

const safe = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');

export function sessionRecordId(host, sessionId) {
  const h = safe(host);
  const id = safe(sessionId);
  if (!h || !id) throw new Error('host と sessionId が要る。');
  return `session-${h}-${id}`;
}

const keyOf = (message) => crypto
  .createHash('sha256')
  .update(`${message.role}\n${message.at || ''}\n${message.text}`)
  .digest('hex')
  .slice(0, 16);

const boundary = (value, kind) => typeof value === 'string'
  ? {
      id: `b-${kind}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}`,
      text: value,
    }
  : value;

export function sessionize(digest, ir) {
  if (!digest?.host || !digest?.sessionId) throw new Error('digest に host と sessionId が要る。');
  if (!digest?.from || !digest?.to) throw new Error('digest にセッションの開始・最終記録時刻が要る。');
  if (!Array.isArray(digest.messages) || digest.messages.length === 0) {
    throw new Error('digest に会話が無い。collect をやり直す。');
  }

  return {
    ...ir,
    schema: SESSION_SCHEMA,
    knowledge: Array.isArray(ir.knowledge) ? ir.knowledge : [],
    background: {
      ...ir.background,
      constraints: (ir.background?.constraints || []).map((value) => boundary(value, 'constraint')),
      nonGoals: (ir.background?.nonGoals || []).map((value) => boundary(value, 'non-goal')),
    },
    meta: {
      ...ir.meta,
      id: sessionRecordId(digest.host, digest.sessionId),
      branch: digest.git?.branch || digest.branch || ir.meta?.branch,
      hosts: [digest.host],
      created: digest.from,
      updated: digest.to,
    },
    session: { id: digest.sessionId, host: digest.host },
    // 成果物の path はモデルに転記させない。和集合にするので、再 trace でも前回結んだものが残る。
    ...(digest.artifacts?.length
      ? { links: { ...ir.links, files: [...new Set([...(ir.links?.files ?? []), ...digest.artifacts])] } }
      : {}),
    utterances: digest.messages.map((message, ordinal) => ({
      key: `u-${keyOf(message)}`,
      ordinal,
      at: message.at || digest.from,
      role: message.role,
      text: message.text,
    })),
  };
}
