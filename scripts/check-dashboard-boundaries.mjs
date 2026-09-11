#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const dashboardSource = path.resolve("dashboard/src");
const sourceExtensions = new Set([".ts", ".tsx"]);
const routeEntries = new Set([
  "default.tsx",
  "error.tsx",
  "layout.tsx",
  "loading.tsx",
  "not-found.tsx",
  "page.tsx",
  "template.tsx",
]);
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

const allPaths = walk(dashboardSource);
const sourceFiles = allPaths.filter(
  (candidate) => fs.statSync(candidate).isFile() && sourceExtensions.has(path.extname(candidate)),
);
const moduleRoots = allPaths.filter((candidate) => {
  if (!fs.statSync(candidate).isDirectory() || !path.basename(candidate).startsWith("_")) return false;
  return [...layerOrder.keys()].some((layer) => fs.existsSync(path.join(candidate, layer)));
});

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

const failures = [];

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
      const isAdjacentRouteEntry =
        path.dirname(file) === path.dirname(targetModule) && routeEntries.has(path.basename(file));
      const targetLayer = layerOf(imported, targetModule);
      if (!isAdjacentRouteEntry || targetLayer !== "ui") {
        failures.push(
          `${path.relative(".", file)} は ${path.relative(".", targetModule)} の非公開実装 ` +
            `${specifier} を参照している。隣接する route entry だけが ui を参照できる`,
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

if (failures.length > 0) {
  console.error(`\n${failures.map((failure) => `  ${failure}`).join("\n\n")}\n`);
  process.exit(1);
}
