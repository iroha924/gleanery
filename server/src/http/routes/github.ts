import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { RequestError } from "octokit";
import { z } from "zod";
import { githubApp, githubConfigured, githubInstallUrl } from "../../github-app.ts";
import { messageOf, reconcileInstallation } from "../../github-connections.ts";
import { queueGithubSync } from "../../github-queue.ts";
import { cfg, env } from "../runtime.ts";

const installationSchema = z.object({ installationId: z.number().int().positive() }).strict();
const syncSchema = z
  .object({
    repositoryId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
  })
  .strict();

async function status() {
  const installation = await cfg().query<{
    id: number;
    accountLogin: string;
    repositorySelection: "all" | "selected";
    status: "active" | "suspended";
  }>(
    `select id::int, account_login as "accountLogin", repository_selection as "repositorySelection", status
     from github_installation order by installed_at desc limit 1`,
  );
  const current = installation.rows[0];
  if (!current) return { configured: true as const, installUrl: githubInstallUrl(env), connection: null };
  const repositories = await cfg().query(
    `select id::text, scope_id::int as "scopeId", full_name as "fullName", private, sync_status as "syncStatus",
            sync_requested_at as "syncRequestedAt", last_synced_at as "lastSyncedAt", last_error as "lastError"
     from github_repository where installation_id=$1 and selected order by full_name`,
    [current.id],
  );
  return {
    configured: true as const,
    installUrl: githubInstallUrl(env),
    connection: { ...current, repositories: repositories.rows },
  };
}

const app = new Hono()
  .get("/github", async (c) => {
    if (!githubConfigured(env)) return c.json({ configured: false, installUrl: null, connection: null });
    try {
      return c.json(await status());
    } catch (error) {
      return c.json({ error: messageOf(error) }, 500);
    }
  })
  .post("/github/installations", zValidator("json", installationSchema), async (c) => {
    try {
      await reconcileInstallation(
        cfg(),
        env,
        c.req.valid("json").installationId,
        `install:${crypto.randomUUID()}`,
      );
      return c.json(await status());
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  })
  .post("/github/refresh", async (c) => {
    try {
      const result = await cfg().query<{ id: number }>(
        "select id::int from github_installation order by installed_at desc limit 1",
      );
      const installationId = result.rows[0]?.id;
      if (installationId === undefined) return c.json({ error: "GitHub App が未接続" }, 409);
      await reconcileInstallation(cfg(), env, installationId, `refresh:${crypto.randomUUID()}`);
      return c.json(await status());
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  })
  .post("/github/sync", zValidator("json", syncSchema), async (c) => {
    const repositoryId = c.req.valid("json").repositoryId;
    try {
      const repositories = await cfg().query<{
        installationId: number;
        repositoryId: string;
        fullName: string;
        scopeId: number;
      }>(
        `select installation_id::int as "installationId", id::text as "repositoryId",
                full_name as "fullName", scope_id::int as "scopeId"
         from github_repository where selected and ($1::bigint is null or id=$1)`,
        [repositoryId ?? null],
      );
      if (repositories.rows.length === 0) return c.json({ error: "同期するリポジトリが無い" }, 404);
      const reason = `manual:${crypto.randomUUID()}`;
      for (const repository of repositories.rows) {
        await cfg().query(
          `update github_repository set sync_status='queued', sync_requested_at=now(), last_error=null,
             updated_at=now() where id=$1`,
          [repository.repositoryId],
        );
        try {
          await queueGithubSync(repository, reason);
        } catch (error) {
          await cfg().query(
            "update github_repository set sync_status='error', last_error=$2, updated_at=now() where id=$1",
            [repository.repositoryId, messageOf(error)],
          );
          throw error;
        }
      }
      return c.json({ ok: true, queued: repositories.rows.length });
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  })
  .delete("/github/installation", async (c) => {
    try {
      const result = await cfg().query<{ id: number }>(
        "select id::int from github_installation order by installed_at desc limit 1",
      );
      const installationId = result.rows[0]?.id;
      if (installationId === undefined) return c.json({ ok: true });
      try {
        await githubApp(env).octokit.rest.apps.deleteInstallation({ installation_id: installationId });
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 404) throw error;
      }
      await cfg().query("delete from github_installation where id=$1", [installationId]);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });

export default app;
