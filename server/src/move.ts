// Moves a project to the key of its current remote after the repository was renamed or transferred.
// Ids stay, so refs (k: / m:) and search words survive. Harvest keys (`pr:<number>#...`) carry no repository, so only the project key
// and the harvested pull requests' URLs change.

import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { lock, rejectedDir, spoolDir, unregisteredDir } from "./capture.ts";
import { inTransaction } from "./db.ts";
import type { DB } from "./db-types.ts";
import type { Place } from "./project.ts";

export type Moved = {
  from: string;
  to: string;
  /** Harvested pull requests whose URL moves to the new repository */
  pullRequests: number;
  /** Spool files on the old key, by place: pending, set aside for unregistered projects, rejected */
  spooled: { pending: number; held: number; rejected: number };
  applied: boolean;
};

const GITHUB = "git:github.com/";
/** `owner/repo` for a key on github.com, or null. */
const repoOf = (key: string): string | null => (key.startsWith(GITHUB) ? key.slice(GITHUB.length) : null);

/** Spool files whose project is `from`, by place: pending, set aside for unregistered projects, rejected. */
function spoolFiles(from: string): Record<keyof Moved["spooled"], string[]> {
  const out: Record<keyof Moved["spooled"], string[]> = { pending: [], held: [], rejected: [] };
  const places = [
    ["pending", spoolDir()],
    ["held", unregisteredDir()],
    ["rejected", rejectedDir()],
  ] as const;
  for (const [place, dir] of places) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if ((JSON.parse(fs.readFileSync(file, "utf8")) as { project?: unknown }).project === from)
          out[place].push(file);
      } catch {
        // A broken record is left to capture flush, which sets it aside
      }
    }
  }
  return out;
}

/** Rewrites only the project field. The file is replaced whole, so a crash leaves either the old or the new record. */
function respool(file: string, to: string): void {
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  record.project = to;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Moves project `from` to `to`. Without apply it only checks and counts.
 * Spool files are rewritten before the database, holding the spool lock, so a failed run can be run again as is.
 */
export async function moveProject(db: Kysely<DB>, from: string, to: Place, apply: boolean): Promise<Moved> {
  if (from === to.key)
    throw new Error(
      `Nothing to move: the current remote's key is already ${from}. Point origin at the renamed repository first`,
    );
  const release = apply ? lock() : () => {};
  if (!release) throw new Error("A capture send holds the spool. Run this again when it finishes");
  try {
    return await inTransaction(db, async (trx) => {
      const project = await trx.selectFrom("project").select("id").where("key", "=", from).executeTakeFirst();
      if (!project)
        throw new Error(
          `Nothing to move: no project has the key ${from} (already moved, or a different key? See \`sphica project list\`)`,
        );
      if (await trx.selectFrom("project").select("id").where("key", "=", to.key).executeTakeFirst())
        throw new Error(
          `Nothing to move: ${to.key} is already registered as another project. If it was added after the rename, delete it with \`sphica project forget ${to.key} --yes\` (its records go too), then move again`,
        );
      const oldRepo = repoOf(from);
      const newRepo = repoOf(to.key);
      const prs =
        oldRepo !== null && newRepo !== null
          ? await trx
              .selectFrom("pull_request")
              .select(["id", "url"])
              .where("project_id", "=", project.id)
              .execute()
          : [];
      const oldUrl = `https://github.com/${oldRepo}/`;
      const moving = prs.filter((p) => p.url?.startsWith(oldUrl));
      const spooled = spoolFiles(from);
      const counts = {
        pending: spooled.pending.length,
        held: spooled.held.length,
        rejected: spooled.rejected.length,
      };
      const moved = { from, to: to.key, pullRequests: moving.length };
      if (!apply) return { ...moved, spooled: counts, applied: false };

      for (const file of [...spooled.pending, ...spooled.held, ...spooled.rejected]) respool(file, to.key);
      await trx
        .updateTable("project")
        .set({ key: to.key, name: to.name })
        .where("id", "=", project.id)
        .execute();
      for (const p of moving)
        await trx
          .updateTable("pull_request")
          .set({ url: `https://github.com/${newRepo}/${(p.url ?? "").slice(oldUrl.length)}` })
          .where("id", "=", p.id)
          .execute();
      return { ...moved, spooled: counts, applied: true };
    });
  } finally {
    release();
  }
}
