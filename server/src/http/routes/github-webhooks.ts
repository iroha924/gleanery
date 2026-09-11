import { Hono } from "hono";
import { z } from "zod";
import { githubApp, githubConfigured } from "../../github-app.ts";
import { messageOf, reconcileInstallation } from "../../github-connections.ts";
import { queueGithubSync } from "../../github-queue.ts";
import { cfg, env } from "../runtime.ts";

const envelopeSchema = z
  .object({
    action: z.string().optional(),
    installation: z.object({ id: z.number().int().positive() }).passthrough(),
    repository: z
      .object({ id: z.number().int().positive(), full_name: z.string(), private: z.boolean() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const installationEvents = new Set(["installation", "installation_repositories"]);
const repositoryEvents = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);

const app = new Hono().post("/github", async (c) => {
  if (!githubConfigured(env)) return c.json({ error: "GitHub App が未設定" }, 503);
  const event = c.req.header("x-github-event");
  const delivery = c.req.header("x-github-delivery");
  const signature = c.req.header("x-hub-signature-256");
  if (!event || !delivery || !signature) return c.json({ error: "GitHub webhook header が無い" }, 400);

  const body = await c.req.text();
  const github = githubApp(env);
  if (!(await github.webhooks.verify(body, signature))) return c.json({ error: "署名が一致しない" }, 401);

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return c.json({ error: "GitHub webhook payload がJSONではない" }, 400);
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: "GitHub webhook payload が不正" }, 400);
  const payload = parsed.data;
  try {
    if (event === "installation" && payload.action === "deleted") {
      await cfg().query("delete from github_installation where id=$1", [payload.installation.id]);
      return c.json({ ok: true });
    }
    if (event === "installation" && payload.action === "suspend") {
      await cfg().query("update github_installation set status='suspended', updated_at=now() where id=$1", [
        payload.installation.id,
      ]);
      return c.json({ ok: true });
    }
    if (installationEvents.has(event)) {
      await reconcileInstallation(cfg(), env, payload.installation.id, `webhook:${delivery}`);
      return c.json({ ok: true });
    }
    if (repositoryEvents.has(event) && payload.repository) {
      const result = await cfg().query<{
        installationId: number;
        repositoryId: string;
        fullName: string;
        scopeId: number;
      }>(
        `select installation_id::int as "installationId", id::text as "repositoryId",
                full_name as "fullName", scope_id::int as "scopeId"
         from github_repository where id=$1 and installation_id=$2 and selected`,
        [payload.repository.id, payload.installation.id],
      );
      const repository = result.rows[0];
      if (repository) {
        await cfg().query(
          `update github_repository set sync_status='queued', sync_requested_at=now(), last_error=null,
             updated_at=now() where id=$1`,
          [repository.repositoryId],
        );
        try {
          await queueGithubSync(repository, `webhook:${delivery}`);
        } catch (error) {
          await cfg().query(
            "update github_repository set sync_status='error', last_error=$2, updated_at=now() where id=$1",
            [repository.repositoryId, messageOf(error)],
          );
          throw error;
        }
      }
    }
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: messageOf(error) }, 500);
  }
});

export default app;
