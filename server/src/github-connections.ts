import type pg from "pg";
import type { Env } from "./db.ts";
import {
  assertAllowedInstallation,
  type GithubRepository,
  githubApp,
  installationRepositories,
} from "./github-app.ts";
import { type GithubSyncMessage, queueGithubSync } from "./github-queue.ts";

export type ConnectedRepository = GithubSyncMessage & {
  private: boolean;
};

export async function reconcileInstallation(
  database: pg.Pool,
  env: Env,
  installationId: number,
  reason: string,
): Promise<ConnectedRepository[]> {
  const app = githubApp(env);
  const installation = await assertAllowedInstallation(app, env, installationId);
  const repositories = await installationRepositories(app, installationId);
  const client = await database.connect();
  const connected: ConnectedRepository[] = [];
  try {
    await client.query("begin");
    await client.query(
      `insert into github_installation
         (id, account_login, account_type, repository_selection, status, updated_at)
       values ($1,$2,$3,$4,$5,now())
       on conflict (id) do update set
         account_login=excluded.account_login, account_type=excluded.account_type,
         repository_selection=excluded.repository_selection, status=excluded.status, updated_at=now()`,
      [
        installation.id,
        installation.accountLogin,
        installation.accountType,
        installation.repositorySelection,
        installation.suspended ? "suspended" : "active",
      ],
    );
    await client.query(
      "update github_repository set selected=false, updated_at=now() where installation_id=$1",
      [installationId],
    );

    for (const repository of repositories) {
      connected.push(await upsertRepository(client, installationId, repository));
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  for (const repository of connected) {
    try {
      await queueGithubSync(repository, reason);
    } catch (error) {
      await database.query(
        `update github_repository set sync_status='error', last_error=$2, updated_at=now() where id=$1`,
        [repository.repositoryId, messageOf(error)],
      );
      throw error;
    }
  }
  return connected;
}

async function upsertRepository(
  client: pg.PoolClient,
  installationId: number,
  repository: GithubRepository,
): Promise<ConnectedRepository> {
  const [owner, name] = repository.fullName.split("/");
  if (!owner || !name || repository.fullName !== `${owner}/${name}`) {
    throw new Error("GitHub repository 名が不正");
  }
  const ident = `git:github.com/${repository.fullName}`;
  const inserted = await client.query<{ id: number }>(
    `insert into scope (ident, ident_kind, host_org, repo_name, label)
     values ($1,'git-remote',$2,$3,$4)
     on conflict (ident) do nothing returning id::int`,
    [ident, owner, name, repository.fullName],
  );
  const scopeId =
    inserted.rows[0]?.id ??
    (await client.query<{ id: number }>("select id::int from scope where ident=$1", [ident])).rows[0]?.id;
  if (scopeId === undefined) throw new Error(`${repository.fullName} のデータソースを作れなかった`);

  await client.query(
    `insert into github_repository
       (id, installation_id, scope_id, full_name, private, selected, sync_status, sync_requested_at, updated_at)
     values ($1,$2,$3,$4,$5,true,'queued',now(),now())
     on conflict (id) do update set
       installation_id=excluded.installation_id, scope_id=excluded.scope_id,
       full_name=excluded.full_name, private=excluded.private, selected=true,
       sync_status='queued', sync_requested_at=now(), last_error=null, updated_at=now()`,
    [repository.id, installationId, scopeId, repository.fullName, repository.private],
  );
  return {
    installationId,
    repositoryId: repository.id,
    fullName: repository.fullName,
    scopeId,
    private: repository.private,
  };
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
