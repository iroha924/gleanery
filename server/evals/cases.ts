// 正解が消した Skill（requirements・design・init・winnow）の節を指す問い。添字（dev / holdout の分け方）と問いの集合の指紋を
// 変えないよう retrieval.json からは消さず、流す前に外す。
export const retired = (c: { expect: string[] }): boolean =>
  c.expect.some((e) => /^doc:plugin\/skills\/(requirements|design|init|winnow)\//.test(e));
