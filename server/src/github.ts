// Reads one pull request for the harvest Skill: its body, conversation, reviews, review comments, timeline, and commits, in time order.
// **Read only, with no database connection.** The text is someone else's, so the CLI prints it inside the record frame.
// Anything it cannot read in full stops the harvest: a partial read would be saved as if it were the whole pull request.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bytes, head } from "./text.ts";
import type { PullRequest } from "./trace.ts";

const run = promisify(execFile);

/** Limits past which a pull request is refused rather than read in part (GitHub's REST lists stop at these, or the text is too large). */
export const LIMITS = { commits: 250, bytes: 2 * 1024 * 1024, part: 64 * 1024 } as const;

/** `owner/repo` for a project key on github.com, or null (harvest reads only GitHub). */
export const repoOf = (key: string): string | null =>
  /^git:github\.com\/([^/]+\/[^/]+)$/.exec(key)?.[1] ?? null;

/** Reads one GitHub REST path of the repository; all follows every page. Tests pass their own. */
export type Get = (path: string, all?: boolean) => Promise<unknown>;

const gh =
  (repo: string): Get =>
  async (path, all = false) => {
    const { stdout } = await run(
      "gh",
      ["api", `repos/${repo}/${path}`, ...(all ? ["--paginate", "--slurp"] : [])],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as unknown;
    return all ? (parsed as unknown[][]).flat() : parsed;
  };

type User = { login?: string } | null;
type Pull = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  created_at: string;
  user: User;
  commits: number;
};
type Comment = { id: number; body: string | null; user: User; created_at: string; html_url: string };
type Review = {
  id: number;
  body: string | null;
  user: User;
  state: string;
  submitted_at: string | null;
  html_url: string;
};
type ReviewComment = Comment & { path: string; line: number | null; in_reply_to_id?: number };
type Commit = { sha: string; commit: { message: string; author: { date: string } | null } };
type Event = {
  event: string;
  created_at?: string;
  actor?: User;
  source?: { issue?: { number: number; title: string; pull_request?: unknown } };
};

// Acknowledgments carry nothing to harvest. **Length alone does not drop a message**: "fixed" or a bare link can be the only sign a finding was handled.
const FILLER =
  // english-exempt: matches Japanese acknowledgments that people write
  /^(lgtm|ok(です)?|了解(です)?|確認しました|ありがとうございます?|なるほど|承知(しました)?|わかりました|👍|:\+1:|:eyes:|:pray:)[!！。.\s]*$/i;
export const isFiller = (body: string): boolean => {
  const t = body.trim();
  return t.length === 0 || FILLER.test(t) || /^!\[[^\]]*\]\([^)]*\)$/.test(t);
};

const who = (u: User) => `@${u?.login ?? "ghost"}`;
const stateOf = (p: Pull): PullRequest["state"] =>
  p.merged_at ? "merged" : p.state === "open" ? "open" : "closed";

/** Recent pull requests, newest activity first, for choosing one to harvest. */
export async function recentPulls(
  repo: string,
  count = 15,
  get: Get = gh(repo),
): Promise<{ number: number; title: string; state: string; updated: string }[]> {
  const list = (await get(`pulls?state=all&sort=updated&direction=desc&per_page=${count}`)) as (Pull & {
    updated_at: string;
  })[];
  return list.map((p) => ({ number: p.number, title: p.title, state: stateOf(p), updated: p.updated_at }));
}

/**
 * The whole pull request as text for an agent to read: the body, then every comment, review, review comment, commit, and
 * cross-reference in time order. Throws when it is too large to read whole.
 */
export async function readPull(
  repo: string,
  number: number,
  get: Get = gh(repo),
): Promise<{ pr: PullRequest; text: string }> {
  const p = (await get(`pulls/${number}`)) as Pull;
  if (p.commits > LIMITS.commits)
    throw new Error(
      `#${number} has ${p.commits} commits; GitHub lists only ${LIMITS.commits}, so it cannot be read whole`,
    );
  const [comments, reviews, reviewComments, commits, events] = await Promise.all([
    get(`issues/${number}/comments?per_page=100`, true) as Promise<Comment[]>,
    get(`pulls/${number}/reviews?per_page=100`, true) as Promise<Review[]>,
    get(`pulls/${number}/comments?per_page=100`, true) as Promise<ReviewComment[]>,
    get(`pulls/${number}/commits?per_page=100`, true) as Promise<Commit[]>,
    get(`issues/${number}/timeline?per_page=100`, true) as Promise<Event[]>,
  ]);
  const entries: { at: string; text: string }[] = [];
  const add = (at: string | null | undefined, text: string) => entries.push({ at: at ?? p.created_at, text });
  for (const c of comments)
    if (c.body && !isFiller(c.body))
      add(c.created_at, `${who(c.user)} commented (${c.html_url}):\n${c.body.trim()}`);
  for (const r of reviews)
    if (r.body?.trim() || r.state !== "COMMENTED")
      add(
        r.submitted_at,
        `${who(r.user)} reviewed: ${r.state} (${r.html_url})${r.body?.trim() ? `\n${r.body.trim()}` : ""}`,
      );
  for (const c of reviewComments)
    if (c.body && !isFiller(c.body))
      add(
        c.created_at,
        `${who(c.user)} on ${c.path}${c.line ? `:${c.line}` : ""}${c.in_reply_to_id ? ` (reply to ${c.in_reply_to_id})` : ""} [${c.id}] (${c.html_url}):\n${c.body.trim()}`,
      );
  for (const c of commits)
    add(c.commit.author?.date, `commit ${c.sha.slice(0, 12)}: ${c.commit.message.trim()}`);
  for (const e of events)
    if (e.event === "cross-referenced" && e.source?.issue)
      add(
        e.created_at,
        `${e.source.issue.pull_request ? "pull request" : "issue"} #${e.source.issue.number} (${e.source.issue.title}) referred to this`,
      );
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const text = [
    `# #${p.number}: ${p.title}`,
    `${stateOf(p)} · opened by ${who(p.user)} ${p.created_at}${p.merged_at ? ` · merged ${p.merged_at}` : ""} · ${p.html_url}`,
    "",
    "## Body",
    "",
    p.body?.trim() || "(empty)",
    "",
    "## In time order",
    "",
    ...entries.map((e) => `- ${e.at} ${e.text.replace(/\n/g, "\n  ")}`),
  ].join("\n");
  if (Buffer.byteLength(text) > LIMITS.bytes)
    throw new Error(
      `#${number} is ${Buffer.byteLength(text)} bytes as text, over the ${LIMITS.bytes}-byte limit, so it cannot be read whole`,
    );
  return {
    pr: { number: p.number, githubId: p.id, title: p.title, url: p.html_url, state: stateOf(p) },
    text,
  };
}

/** Splits the text into parts of at most size bytes, at line ends where it can (an agent reads one part per call). */
export function parts(text: string, size: number = LIMITS.part): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (let line of text.split("\n")) {
    while (bytes(line) > size) {
      push();
      const cut = head(line, size);
      out.push(cut);
      line = line.slice(cut.length);
    }
    const next = cur ? `${cur}\n${line}` : line;
    if (bytes(next) > size) {
      push();
      cur = line;
    } else cur = next;
  }
  push();
  return out.length ? out : [""];
}
