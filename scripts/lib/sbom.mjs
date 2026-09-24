// SBOM（CycloneDX）が、バンドルして配る依存を全部載せているかの照合。配る依存の正本は THIRD_PARTY_NOTICES.md の表
// （scripts/third-party-notices.mjs が node_modules から作る）。SBOM が多く載せるのは構わない。足りない側だけが偽りになる。

/** THIRD_PARTY_NOTICES.md の表の package とバージョン。 */
function noticed(text) {
  const out = new Set();
  for (const line of text.split("\n")) {
    const m = /^\| (\S+) \| (\S+) \| /.exec(line);
    if (m && m[1] !== "package" && !m[1].startsWith("---")) out.add(`${m[1]} ${m[2]}`);
  }
  return out;
}

/** 照合の問題。空なら通る。 */
export function sbomProblems(noticesText, bom) {
  if (bom?.bomFormat !== "CycloneDX" || !Array.isArray(bom.components))
    return ["SBOM が CycloneDX の JSON ではない"];
  const want = noticed(noticesText);
  if (want.size === 0) return ["THIRD_PARTY_NOTICES.md から package を読めない"];
  const have = new Set(
    bom.components
      .filter((c) => c.type === "library")
      .map((c) => `${c.group ? `${c.group}/${c.name}` : c.name} ${c.version}`),
  );
  return [...want].filter((p) => !have.has(p)).map((p) => `SBOM に ${p} が無い`);
}
