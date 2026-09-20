import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ChatPage } from "@/features/_chat/ui/chat-page";

// URL が正本。壊れた値でも 404 にせず、新しい会話として開く。
// retain は置かない（開いていた会話の id をセッションと会議へ漏らさない）。
const searchSchema = z.object({
  /** 開いている会話の id。新しい会話では消える */
  chat: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/")({ validateSearch: searchSchema, component: ChatPage });
