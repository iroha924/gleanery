// SBOM（CycloneDX）が、バンドルして配る依存を全部載せているかの照合。配る依存の正本は THIRD_PARTY_NOTICES.md の表
// （scripts/third-party-notices.mjs が node_modules から作る）。足りなくても多すぎても、SBOM が配る物の中身を偽る。

/** THIRD_PARTY_NOTICES.md の表の package とバージョンと、形の崩れた行。崩れた行を黙って外さない。 */
function noticed(text) {
  const out = new Set();
  const broken = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || /^\| package \|/.test(line) || /^\|[-| ]+\|$/.test(line)) continue;
    const m = /^\| (\S+) \| (\S+) \| [^|]+ \|$/.exec(line);
    if (m) out.add(`${m[1]} ${m[2]}`);
    else broken.push(line);
  }
  return { out, broken };
}

/** 照合の問題。空なら通る。 */
export function sbomProblems(noticesText, bom) {
  if (bom?.bomFormat !== "CycloneDX" || !Array.isArray(bom.components))
    return ["SBOM が CycloneDX の JSON ではない"];
  const { out: want, broken } = noticed(noticesText);
  if (broken.length) return broken.map((l) => `THIRD_PARTY_NOTICES.md の表の行を読めない: ${l}`);
  if (want.size === 0) return ["THIRD_PARTY_NOTICES.md から package を読めない"];
  const have = new Set(
    bom.components
      .filter((c) => c.type === "library")
      .map((c) => `${c.group ? `${c.group}/${c.name}` : c.name} ${c.version}`),
  );
  return [
    ...[...want].filter((p) => !have.has(p)).map((p) => `SBOM に ${p} が無い`),
    ...[...have].filter((p) => !want.has(p)).map((p) => `SBOM に同梱していない ${p} がある`),
  ];
}
