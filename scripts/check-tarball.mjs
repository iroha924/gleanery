#!/usr/bin/env node
// Checks an npm pack tarball the way users receive it (run by CI check and release). Usage: node scripts/check-tarball.mjs <tgz>
// It checks the file list (scripts/lib/tarball.mjs), that the version matches the repository, and that the CLI starts outside the repository and creates a database in a temp HOME

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tarballProblems, trackedDistribution } from "./lib/tarball.mjs";

const tgz = process.argv[2] && path.resolve(process.argv[2]);
if (!tgz) throw new Error("pass the tarball path");
const root = path.resolve(import.meta.dirname, "..");
const paths = new Set(
  execFileSync("tar", ["tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.endsWith("/"))
    .map((f) => f.replace(/^package\//, "")),
);
const problems = tarballProblems(paths, trackedDistribution(root));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

// **Extract outside the repository.** Inside it, a wrong bundle would still resolve by walking up and pass.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-tarball-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-home-"));
// Do not pass GLEANERY_DB, which points to the owner's database, to the child (only the temp HOME database is created)
const parentEnv = { ...process.env };
delete parentEnv.GLEANERY_DB;
try {
  execFileSync("tar", ["xzf", tgz, "-C", out]);
  const pkg = path.join(out, "package");
  const cli = (...args) =>
    execFileSync(process.execPath, [path.join(pkg, "dist", "cli.js"), ...args], {
      cwd: out,
      encoding: "utf8",
      env: { ...parentEnv, HOME: home, USERPROFILE: home },
    });
  const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
  const expected = JSON.parse(fs.readFileSync(path.join(root, "plugin", "package.json"), "utf8")).version;
  if (version !== expected)
    throw new Error(`tarball is ${version}, but the repository version is ${expected} (stale tarball)`);
  const named = cli("--version").trim().split(/\s+/)[0];
  if (named !== version)
    throw new Error(`the tarball CLI reported ${named}, but the package version is ${version}`);
  cli("--help");
  cli("db", "--help");
  cli("init");
  if (!fs.existsSync(path.join(home, ".gleanery", "gleanery.db")))
    throw new Error("init did not create a database");
  // Web UI assets no longer ship (the UI moved to the terminal). If they remain, bundle forgot to remove them
  if (fs.existsSync(path.join(pkg, "dist", "dashboard")))
    throw new Error("tarball still contains dist/dashboard");
  console.log(
    `tarball: ${paths.size} files matching the shipped list. CLI ${version} started and created a database`,
  );
} finally {
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
