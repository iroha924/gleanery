#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const dashboardSource = path.resolve("dashboard/src");
const sourceExtensions = new Set([".ts", ".tsx"]);
// TanStack Router の route は src/routes/ 配下の file 名そのものが path になる。
// 機能の module は routesDirectory の外に置く（`_` 始まりは pathless layout の記法で、
// routes の下に置くと generator が route として扱い、中身を書き換えて壊す）。
const routesDirectory = path.join(dashboardSource, "routes");
const layerOrder = new Map([
  ["api", 0],
  ["model", 1],
  ["ui", 2],
]);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? [absolute, ...walk(absolute)] : [absolute];
  });
}

const failuresEarly = [];
const allPaths = walk(dashboardSource);
const sourceFiles = allPaths.filter(
  (candidate) => fs.statSync(candidate).isFile() && sourceExtensions.has(path.extname(candidate)),
);
const featuresDirectory = path.join(dashboardSource, "features");
const moduleRoots = allPaths.filter((candidate) => {
  if (!fs.statSync(candidate).isDirectory()) return false;
  if (path.dirname(candidate) !== featuresDirectory) return false;
  return true;
});

// **`_` を名前から外すと検査対象から消える**形にしない。features 直下は全部 module として扱い、
// 名前のほうを検査する（`_` は TanStack Router の pathless layout の記法と揃える決まり）。
for (const root of moduleRoots) {
  if (!path.basename(root).startsWith("_")) {
    failuresEarly.push(
      `${path.relative(".", root)} は features 直下なので \`_\` で始める（routes 配下の generator と綴りを揃える）`,
    );
  }
}

function isInside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveImport(importer, specifier) {
  if (specifier.startsWith("@/")) return path.join(dashboardSource, specifier.slice(2));
  if (specifier.startsWith(".")) return path.resolve(path.dirname(importer), specifier);
  return null;
}

function importsOf(file) {
  const source = fs.readFileSync(file, "utf8");
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^;]*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function layerOf(file, moduleRoot) {
  const [layer] = path.relative(moduleRoot, file).split(path.sep);
  return layerOrder.has(layer) ? layer : null;
}

const failures = [...failuresEarly];

for (const file of sourceFiles) {
  const sourceModule = moduleRoots.find((root) => isInside(file, root));
  if (sourceModule && !layerOf(file, sourceModule)) {
    failures.push(
      `${path.relative(".", file)} は ${path.relative(".", sourceModule)} の api / model / ui の外にある`,
    );
  }

  for (const specifier of importsOf(file)) {
    const imported = resolveImport(file, specifier);
    if (!imported) continue;
    const targetModule = moduleRoots.find((root) => isInside(imported, root));
    if (!targetModule) continue;

    if (!isInside(file, targetModule)) {
      const isRouteEntry = isInside(file, routesDirectory);
      const targetLayer = layerOf(imported, targetModule);
      if (!isRouteEntry || targetLayer !== "ui") {
        failures.push(
          `${path.relative(".", file)} は ${path.relative(".", targetModule)} の非公開実装 ` +
            `${specifier} を参照している。route entry だけが ui を参照できる`,
        );
      }
      continue;
    }

    const sourceLayer = layerOf(file, targetModule);
    const targetLayer = layerOf(imported, targetModule);
    if (sourceLayer && targetLayer && layerOrder.get(sourceLayer) < layerOrder.get(targetLayer)) {
      failures.push(
        `${path.relative(".", file)} の ${sourceLayer} から ${targetLayer} への依存は逆向き。` +
          "許可する向きは ui → model → api",
      );
    }
  }
}

// **`ui` と `model` から共有の API 入口を直に引かない。**引くと、その画面だけ自分の `api` 層を
// 飛ばし、失敗の扱いとエラー文が feature の外で決まる。`@/lib/api` を触るのは `api/` 層だけにする。
const SHARED_API = /^@\/lib\/(api|api-client)$/;
for (const file of sourceFiles) {
  const home = moduleRoots.find((root) => isInside(file, root));
  if (!home) continue;
  const layer = layerOf(file, home);
  if (layer !== "ui" && layer !== "model") continue;
  for (const specifier of importsOf(file)) {
    if (!SHARED_API.test(specifier)) continue;
    failures.push(
      `${path.relative(".", file)} が ${specifier} を直に参照している。` +
        `${layer} は同じ module の api/ を通す（失敗の扱いを feature の中に閉じる）`,
    );
  }
}

// **route entry に機能を書かない。**route 設定・search schema・feature の ui の import に限る。
// 実装を直書きすると、その画面だけ層の検査から外れ（module root が無いため）、
// 同じ機能が feature 側と route 側の 2 通りで書かれる余地が残る。
const ROUTE_ALLOWED = [
  /^@tanstack\/react-router$/,
  /^zod$/,
  /^@\/features\/_[^/]+\/ui\//,
  // route の骨格（外枠と、描画に失敗したときの受け皿）だけは components から引ける。
  /^@\/components\/(dashboard-shell|route-failed)$/,
];
for (const file of sourceFiles) {
  if (!isInside(file, routesDirectory)) continue;
  if (path.basename(file) === "routeTree.gen.ts") continue;
  for (const specifier of importsOf(file)) {
    if (ROUTE_ALLOWED.some((allowed) => allowed.test(specifier))) continue;
    failures.push(
      `${path.relative(".", file)} が ${specifier} を参照している。route entry は route 設定と ` +
        "search schema と feature の ui だけを持つ。実装は src/features/_名前/ へ置く",
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.map((failure) => `  ${failure}`).join("\n\n")}\n`);
  process.exit(1);
}
