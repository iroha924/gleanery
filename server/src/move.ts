// Moves a project to the key of its current remote after the repository was renamed or transferred.
// Ids stay, so refs (k: / m:) and search words survive. Rows built from GitHub get the new repository in their keys and URLs,
// and their content hashes are recomputed the way the GitHub sync computes them, so the next sync finds nothing to rewrite.

import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { lock, rejectedDir, spoolDir, unregisteredDir } from "./capture.ts";
import { inTransaction } from "./db.ts";
import type { DB } from "./db-types.ts";
import { decisionHash } from "./decisions.ts";
import type { Place } from "./project.ts";

export type Moved = {
  from: string;
  to: string;
  knowledge: number;
  terms: number;
  conversations: number;
  spooled: number;
  applied: boolean;
};

const GITHUB = "git:github.com/";
/** `owner/repo` for a key on github.com, or null. */
const repoOf = (key: string): string | null => (key.startsWith(GITHUB) ? key.slice(GITHUB.length) : null);

/** The status and parent a PR row had when extracted: `#<h>-<n>` is a decision, `.c` its chosen option, `.rN` a rejected one. */
function extracted(key: string): { status: string; parent: string | null } | null {
  const m = /^(.*#[0-9a-f]{12}-\d+)(?:\.(c|r\d+))?$/.exec(key);
  if (!m?.[1]) return null;
  if (!m[2]) return { status: "accepted", parent: null };
  return { status: m[2] === "c" ? "chosen" : "rejected", parent: m[1] };
}

/** Spool files (queued, unregistered, rejected) whose project is `from`. */
function spoolFiles(from: string): string[] {
  const out: string[] = [];
  for (const dir of [spoolDir(), unregisteredDir(), rejectedDir()]) {
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
          out.push(file);
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
 * Moves project `from` to `to`. Without apply it only checks and counts. It refuses before writing anything when a row with valid
 * search words has a hash the GitHub sync would not produce (moving it would silently drop those words).
 * Spool files are rewritten before the database, holding the spool lock, so a failed run can be run again as is.
 */
export async function moveProject(db: Kysely<DB>, from: string, to: Place, apply: boolean): Promise<Moved> {
  if (from === to.key) throw new Error(`The current remote's key is already ${from}. Nothing to move`);
  const release = apply ? lock() : () => {};
  if (!release) throw new Error("A capture send holds the spool. Run this again when it finishes");
  try {
    return await inTransaction(db, async (trx) => {
      const project = await trx.selectFrom("project").select("id").where("key", "=", from).executeTakeFirst();
      if (!project) throw new Error(`No project has the key ${from}`);
      if (await trx.selectFrom("project").select("id").where("key", "=", to.key).executeTakeFirst())
        throw new Error(`${to.key} is already registered as another project`);

      const oldRepo = repoOf(from);
      const newRepo = repoOf(to.key);
      const github = oldRepo !== null && newRepo !== null;
      const rows = github
        ? await trx
            .selectFrom("knowledge as k")
            .leftJoin("knowledge_terms as t", "t.knowledge_id", "k.id")
            .select([
              "k.id",
              "k.source_key",
              "k.kind",
              "k.body",
              "k.reason",
              "k.heading",
              "k.refs",
              "k.occurred_at",
              "k.content_hash",
              "t.content_hash as terms_hash",
            ])
            .where("k.project_id", "=", project.id)
            .where((eb) =>
              eb(
                eb.fn("substr", ["k.source_key", eb.val(1), eb.val(`github:${oldRepo}/`.length)]),
                "=",
                `github:${oldRepo}/`,
              ),
            )
            .execute()
        : [];
      /** Search words are in effect only while their hash is the record's */
      const hasWords = (r: (typeof rows)[number]) => r.terms_hash?.equals(r.content_hash) === true;
      const oldUrl = `https://github.com/${oldRepo}/`;
      const newUrl = `https://github.com/${newRepo}/`;
      const swap = (key: string) => `github:${newRepo}/${key.slice(`github:${oldRepo}/`.length)}`;
      const refsOf = (refs: string[]) =>
        refs.map((u) => (u.startsWith(oldUrl) ? newUrl + u.slice(oldUrl.length) : u));
      const hashOf = (r: (typeof rows)[number], refs: string[], rekey: (k: string) => string) => {
        const x = extracted(r.source_key);
        if (!x || r.heading === null) return null;
        return decisionHash({
          kind: r.kind,
          status: x.status,
          body: r.body,
          reason: r.reason,
          heading: r.heading,
          refs: JSON.stringify(refs),
          occurred: r.occurred_at,
          parent: x.parent === null ? null : rekey(x.parent),
        });
      };
      const unmatched = rows.filter(
        (r) => hasWords(r) && !hashOf(r, r.refs, (k) => k)?.equals(r.content_hash),
      );
      if (unmatched.length)
        throw new Error(
          `These records have search words but a hash the GitHub sync would not produce, so moving them would drop the words: ${unmatched
            .slice(0, 5)
            .map((r) => r.source_key)
            .join(
              ", ",
            )}${unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : ""}. Nothing was moved`,
        );
      const conversations = github
        ? await trx
            .selectFrom("conversation")
            .select(["id", "external_id"])
            .where("project_id", "=", project.id)
            .where("origin", "=", "github")
            .execute()
        : [];
      const spooled = spoolFiles(from);
      const kept = rows.filter(hasWords).length;
      const moved = {
        from,
        to: to.key,
        knowledge: rows.length,
        terms: kept,
        conversations: conversations.length,
      };
      if (!apply) return { ...moved, spooled: spooled.length, applied: false };

      for (const file of spooled) respool(file, to.key);
      await trx
        .updateTable("project")
        .set({ key: to.key, name: to.name })
        .where("id", "=", project.id)
        .execute();
      for (const r of rows) {
        const refs = refsOf(r.refs);
        const hash = hashOf(r, refs, swap) ?? r.content_hash;
        await trx
          .updateTable("knowledge")
          .set({ source_key: swap(r.source_key), refs: JSON.stringify(refs), content_hash: hash })
          .where("id", "=", r.id)
          .execute();
        if (hasWords(r))
          await trx
            .updateTable("knowledge_terms")
            .set({ content_hash: hash })
            .where("knowledge_id", "=", r.id)
            .execute();
      }
      for (const c of conversations)
        if (c.external_id.startsWith(`${oldRepo}#`))
          await trx
            .updateTable("conversation")
            .set({ external_id: `${newRepo}${c.external_id.slice(`${oldRepo}`.length)}` })
            .where("id", "=", c.id)
            .execute();
      return { ...moved, spooled: spooled.length, applied: true };
    });
  } finally {
    release();
  }
}
