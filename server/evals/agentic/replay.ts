#!/usr/bin/env node
// Replays the recall / read calls of saved runs on the DB they used, reports how many replays matched the recorded responses, and
// recounts where each answer was shown. Mismatched calls are unconfirmed and reported apart. Writes <run dir>/replay.json.
//   SPHICA_DB=<the runs' DB copy> bun run evals:replay -- <run dir> ...

import fs from "node:fs";
import path from "node:path";
import { openReader } from "../../src/db.ts";
import { cases, fixedDb, knowledgeRows, type Result, sha256File } from "./run.ts";
import { callsOf, codexCallsOf, replay, type Session, sessionOf } from "./session.ts";

const dirs = process.argv.slice(2);
if (dirs.length === 0) throw new Error("pass run dirs (<OUT>/<name>/<split>)");
const file = fixedDb();
const db = openReader(file);
const byRef = new Map(knowledgeRows(file).map((r) => [`k:${r.id}`, r.source_key]));
const keyOf = (ref: string) => (ref.startsWith("m:") ? ref.slice(2) : (byRef.get(ref) ?? null));

const dbHash = sha256File(file);
for (const dir of dirs) {
  const {
    results,
    db: used,
    host,
  } = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")) as {
    results: Result[];
    db?: string;
    host?: string;
  };
  // Refs map to answer keys through this DB, so another copy could render the same text yet map to other keys
  if (used !== dbHash) {
    console.log(`${dir}: skipped, the run used DB ${used ?? "not recorded"} and SPHICA_DB is ${dbHash}`);
    continue;
  }
  const why: Record<string, number> = {};
  let calls = 0;
  let matched = 0;
  const sessions: { i: number; rank: number; session: Session }[] = [];
  for (const r of results) {
    const trace = path.join(dir, `q${r.i}`, "trace.jsonl");
    const events = fs
      .readFileSync(trace, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    // Codex calls carry their cwd in their arguments; its stream has no init event
    const replayed = await replay(
      host === "codex" ? codexCallsOf(events) : callsOf(events),
      db,
      String(init?.cwd ?? ""),
    );
    for (const c of replayed) {
      if (c.tool === "other") continue;
      calls++;
      if (c.matched) matched++;
      else why[c.why ?? "?"] = (why[c.why ?? "?"] ?? 0) + 1;
    }
    sessions.push({ i: r.i, rank: r.rank, session: sessionOf(replayed, keyOf, cases[r.i]?.expect ?? []) });
  }
  fs.writeFileSync(path.join(dir, "replay.json"), JSON.stringify({ calls, matched, why, sessions }, null, 1));
  const misses = sessions.filter((s) => s.rank !== 0);
  const count = (f: (s: Session) => boolean) => misses.filter((m) => f(m.session)).length;
  console.log(
    `${dir}: ${matched}/${calls} calls matched${
      Object.keys(why).length
        ? ` (${Object.entries(why)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")})`
        : ""
    }; ` +
      `misses ${misses.length}: shown in recall ${count((s) => s.exposed === "recall")}, first shown in read ${count((s) => s.exposed === "read")}, ` +
      `never shown ${count((s) => s.exposed === null && s.unconfirmed === 0)}, unconfirmed ${count((s) => s.exposed === null && s.unconfirmed > 0)}`,
  );
}
await db.destroy();
