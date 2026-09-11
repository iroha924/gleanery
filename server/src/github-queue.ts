import { send } from "@vercel/queue";
import { z } from "zod";

export const GITHUB_SYNC_TOPIC = "github-sync";

export const githubSyncMessageSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.string().regex(/^[1-9]\d*$/),
  fullName: z.string().regex(/^[^/]+\/[^/]+$/),
  scopeId: z.number().int().positive(),
});

export type GithubSyncMessage = z.infer<typeof githubSyncMessageSchema>;

export async function queueGithubSync(message: GithubSyncMessage, reason: string): Promise<void> {
  await send(GITHUB_SYNC_TOPIC, githubSyncMessageSchema.parse(message), {
    region: "sin1",
    idempotencyKey: `${message.repositoryId}:${reason}`.slice(0, 256),
  });
}
