import { handleCallback } from "@vercel/queue";
import { Hono } from "hono";
import { loadEnv, pool } from "./db.ts";
import { collect, ingestThreads } from "./github.ts";
import { githubApp, installationSource } from "./github-app.ts";
import { messageOf } from "./github-connections.ts";
import { GITHUB_SYNC_TOPIC, type GithubSyncMessage, githubSyncMessageSchema } from "./github-queue.ts";

const env = loadEnv(process.cwd());
let workerPool: ReturnType<typeof pool> | null = null;
const database = () => (workerPool ??= pool(env, { as: "github" }));
let workerApp: ReturnType<typeof githubApp> | null = null;
const app = () => (workerApp ??= githubApp(env));

const callback = handleCallback<GithubSyncMessage>(
  async (raw) => {
    const message = githubSyncMessageSchema.parse(raw);
    const selected = await database().query<{ scopeId: number }>(
      `select scope_id::int as "scopeId" from github_repository
       where id=$1 and installation_id=$2 and full_name=$3 and selected`,
      [message.repositoryId, message.installationId, message.fullName],
    );
    if (selected.rows[0]?.scopeId !== message.scopeId) return;

    await database().query(
      "update github_repository set sync_status='syncing', last_error=null, updated_at=now() where id=$1",
      [message.repositoryId],
    );
    try {
      const source = await installationSource(app(), message.installationId, message.fullName);
      const { prs, threads } = await collect(message.fullName, source);
      const client = await database().connect();
      try {
        await ingestThreads(client, env, message.fullName, message.scopeId, prs, threads);
      } finally {
        client.release();
      }
      await database().query(
        `update github_repository set sync_status='synced', last_synced_at=now(), last_error=null,
           updated_at=now() where id=$1`,
        [message.repositoryId],
      );
    } catch (error) {
      await database().query(
        "update github_repository set sync_status='error', last_error=$2, updated_at=now() where id=$1",
        [message.repositoryId, messageOf(error)],
      );
      throw error;
    }
  },
  {
    visibilityTimeoutSeconds: 300,
    retry: (_error, metadata) => (metadata.deliveryCount < 5 ? { afterSeconds: 30 } : { acknowledge: true }),
  },
);

const worker = new Hono().post("*", (c) => callback(c.req.raw));

// Vercel detects this filename and default export as the private queue consumer service.
export default worker;

export { GITHUB_SYNC_TOPIC };
