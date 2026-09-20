import { createFileRoute } from "@tanstack/react-router";
import { MeetingPage } from "@/features/_meeting/ui/meeting-page";

export const Route = createFileRoute("/mtg")({ component: MeetingPage });
