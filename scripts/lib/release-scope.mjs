// npm package に入る変更を、plugin host へ届ける必要があるかで分ける。
// version gate、release plan、手動release準備はすべてこの判定を使う。

const EXACT_PACKAGE_INPUTS = new Set([
  "server/package.json",
  "server/bun.lock",
  "server/tsconfig.json",
  "dashboard/index.html",
  "dashboard/package.json",
  "dashboard/bun.lock",
  "dashboard/tsconfig.app.json",
  "dashboard/tsconfig.json",
  "dashboard/tsconfig.node.json",
  "dashboard/vite.config.ts",
  "scripts/bundle.mjs",
  "scripts/bundle-cli.ts",
  "scripts/third-party-notices.mjs",
]);

const PACKAGE_PREFIXES = [
  "plugin/",
  "server/src/",
  "dashboard/src/",
  "dashboard/public/",
  "db/",
  "scripts/licenses/",
];

const NPM_ONLY_EXACT = new Set([
  "server/src/server.ts",
  "dashboard/index.html",
  "dashboard/package.json",
  "dashboard/bun.lock",
  "dashboard/tsconfig.app.json",
  "dashboard/tsconfig.json",
  "dashboard/tsconfig.node.json",
  "dashboard/vite.config.ts",
]);

const NPM_ONLY_PREFIXES = ["dashboard/src/", "dashboard/public/", "server/src/http/"];

export function isPackageInput(file) {
  return EXACT_PACKAGE_INPUTS.has(file) || PACKAGE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function isNpmOnlyInput(file) {
  return NPM_ONLY_EXACT.has(file) || NPM_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function releaseKind(files) {
  const inputs = files.filter(isPackageInput);
  if (inputs.length === 0) return "none";
  return inputs.every(isNpmOnlyInput) ? "npm" : "plugin";
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
