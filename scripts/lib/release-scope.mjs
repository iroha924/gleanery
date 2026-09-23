// npm package に入る変更かを判定する。入るなら npm と plugin channel の 3 つを同じバージョンへ上げる（種別 plugin）。
// version gate、release plan、手動release準備はすべてこの判定を使う。

const EXACT_PACKAGE_INPUTS = new Set([
  "server/package.json",
  "server/bun.lock",
  "server/tsconfig.json",
  "scripts/bundle.mjs",
  "scripts/bundle-cli.ts",
  "scripts/third-party-notices.mjs",
  // bundle が plugin/README.md へ写し、npm の package のページに出る
  "README.md",
]);

const PACKAGE_PREFIXES = ["plugin/", "server/src/", "db/", "scripts/licenses/"];

export function isPackageInput(file) {
  return EXACT_PACKAGE_INPUTS.has(file) || PACKAGE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function releaseKind(files) {
  const inputs = files.filter(isPackageInput);
  return inputs.length === 0 ? "none" : "plugin";
}

export function withoutReleaseVersion(text) {
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    delete value.version;
    for (const plugin of Array.isArray(value.plugins) ? value.plugins : []) {
      delete plugin.version;
      if (plugin.source && typeof plugin.source === "object") delete plugin.source.version;
    }
    return JSON.stringify(value);
  } catch {
    return text;
  }
}
