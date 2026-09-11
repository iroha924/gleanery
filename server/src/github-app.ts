import { App, Octokit, type Octokit as OctokitClient } from "octokit";
import type { Env } from "./db.ts";
import type { GithubSource, IssueComment, Pull, RawIssue, ReviewComment } from "./github.ts";

const GithubOctokit = Octokit.defaults({
  userAgent: "mitos-github-app",
  request: { headers: { "x-github-api-version": "2026-03-10" } },
});

export type GithubRepository = {
  id: string;
  fullName: string;
  private: boolean;
};

function requireGithubEnv(env: Env) {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
  const slug = env.GITHUB_APP_SLUG;
  const allowedAccount = env.GITHUB_ALLOWED_ACCOUNT;
  if (!appId || !privateKey || !webhookSecret || !slug || !allowedAccount) {
    throw new Error(
      "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_WEBHOOK_SECRET / " +
        "GITHUB_APP_SLUG / GITHUB_ALLOWED_ACCOUNT が要る",
    );
  }
  return { appId, privateKey, webhookSecret, slug, allowedAccount };
}

export function githubConfigured(env: Env): boolean {
  try {
    requireGithubEnv(env);
    return true;
  } catch {
    return false;
  }
}

export function githubApp(env: Env): App {
  const config = requireGithubEnv(env);
  return new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhooks: { secret: config.webhookSecret },
    Octokit: GithubOctokit,
  });
}

export function githubInstallUrl(env: Env): string {
  const { slug } = requireGithubEnv(env);
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

export async function assertAllowedInstallation(app: App, env: Env, installationId: number) {
  const { allowedAccount } = requireGithubEnv(env);
  const { data } = await app.octokit.rest.apps.getInstallation({ installation_id: installationId });
  const account = data.account;
  const login =
    account && "login" in account ? account.login : account && "slug" in account ? account.slug : undefined;
  if (!login || login.toLowerCase() !== allowedAccount.toLowerCase()) {
    throw new Error("許可した GitHub アカウントの installation ではない");
  }
  return {
    id: data.id,
    accountLogin: login,
    accountType: account && "type" in account ? account.type : "Organization",
    repositorySelection: data.repository_selection,
    suspended: data.suspended_at !== null,
  };
}

export async function installationRepositories(
  app: App,
  installationId: number,
): Promise<GithubRepository[]> {
  const repositories: GithubRepository[] = [];
  for await (const { repository } of app.eachRepository.iterator({ installationId })) {
    repositories.push({
      id: String(repository.id),
      fullName: repository.full_name,
      private: repository.private,
    });
  }
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function installationSource(
  app: App,
  installationId: number,
  fullName: string,
): Promise<GithubSource> {
  const octokit = await app.getInstallationOctokit(installationId);
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo || fullName !== `${owner}/${repo}`) throw new Error("GitHub repository 名が不正");
  return sourceFromOctokit(octokit, owner, repo);
}

function sourceFromOctokit(octokit: OctokitClient, owner: string, repo: string): GithubSource {
  return {
    pulls: async () =>
      (await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "all",
        per_page: 100,
      })) as Pull[],
    issues: async () =>
      (await octokit.paginate(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: "all",
        per_page: 100,
      })) as RawIssue[],
    reviewComments: async () =>
      (await octokit.paginate(octokit.rest.pulls.listReviewCommentsForRepo, {
        owner,
        repo,
        per_page: 100,
      })) as ReviewComment[],
    issueComments: async () =>
      (await octokit.paginate(octokit.rest.issues.listCommentsForRepo, {
        owner,
        repo,
        per_page: 100,
      })) as IssueComment[],
  };
}
