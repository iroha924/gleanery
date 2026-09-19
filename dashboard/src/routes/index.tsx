import { createFileRoute } from "@tanstack/react-router";
import { ChatPage } from "@/features/_chat/ui/chat-page";

export const Route = createFileRoute("/")({ component: ChatPage });
