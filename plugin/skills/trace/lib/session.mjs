import crypto from 'node:crypto';

export const SESSION_SCHEMA = 'session/2';

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

export function sessionize(digest, ir) {
  if (!digest?.host || !digest?.sessionId) throw new Error('digest に host と sessionId が要る。');
  if (!digest?.from || !digest?.to) throw new Error('digest にセッションの開始・最終記録時刻が要る。');
  if (!Array.isArray(digest.messages) || digest.messages.length === 0) {
    throw new Error('digest に会話が無い。collect をやり直す。');
  }

  return {
    ...ir,
    schema: SESSION_SCHEMA,
    meta: {
      ...ir.meta,
      id: sessionRecordId(digest.host, digest.sessionId),
      branch: digest.git?.branch || digest.branch || ir.meta?.branch,
      hosts: [digest.host],
      created: digest.from,
      updated: digest.to,
    },
    session: { id: digest.sessionId, host: digest.host },
    utterances: digest.messages.map((message, ordinal) => ({
      key: `u-${keyOf(message)}`,
      ordinal,
      at: message.at || digest.from,
      role: message.role,
      text: message.text,
    })),
  };
}
