import { send } from "@vercel/queue";

export const GITHUB_SYNC_TOPIC = "github-sync";

export type GithubSyncMessage = {
  installationId: number;
  repositoryId: string;
  fullName: string;
  scopeId: number;
};

export async function queueGithubSync(message: GithubSyncMessage, reason: string): Promise<void> {
  await send(GITHUB_SYNC_TOPIC, message, {
    region: "sin1",
    idempotencyKey: `${message.repositoryId}:${reason}`.slice(0, 256),
  });
}
