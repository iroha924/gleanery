import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  AudioLinesIcon,
  ChevronDownIcon,
  GitBranchIcon,
  Layers2Icon,
  MessageCircleIcon,
  MessagesSquareIcon,
} from "lucide-react-motion";
import type * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Project } from "@/lib/api";
import { useProject } from "@/lib/project";

const NAVIGATION = [
  { to: "/sessions", label: "セッション", icon: MessagesSquareIcon },
  { to: "/", label: "チャット", icon: MessageCircleIcon },
  { to: "/mtg", label: "MTG録音", icon: AudioLinesIcon },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const matchRoute = useMatchRoute();
  const { setOpenMobile } = useSidebar();
  const closeMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="gap-3 p-2">
        <div className="relative flex h-10 items-center justify-start">
          <Link
            to="/"
            onClick={closeMobile}
            className="flex min-w-0 items-center gap-2.5 px-2 text-lg font-semibold tracking-[-0.025em] group-data-[collapsible=icon]:hidden"
          >
            <Logo />
            mitos
          </Link>
          <SidebarTrigger className="absolute right-0 shrink-0 rounded-md group-data-[collapsible=icon]:static group-data-[collapsible=icon]:size-8!" />
        </div>
        <div className="group-data-[collapsible=icon]:hidden">
          <ProjectSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAVIGATION.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild isActive={!!matchRoute({ to: item.to })} tooltip={item.label}>
                    <Link to={item.to} onClick={closeMobile}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 16 16" className="size-5 shrink-0" fill="none" aria-hidden="true">
      <g transform="translate(-0.3 0.75)">
        <path
          d="M4 2 V10 a2.5 2.5 0 0 0 5 0 V5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
        />
        <circle cx="12" cy="5" r="1.6" fill="currentColor" />
      </g>
    </svg>
  );
}

const DAY = 86_400_000;

/** 最後の同期。**2 日より前か失敗なら目立たせる**（日次同期が止まっていると、古い判断を今のものとして読む）。 */
function syncNote(p: Project): { text: string; stale: boolean } {
  const failed = p.connectors.find((c) => c.lastError);
  if (failed) return { text: `${failed.provider === "github" ? "GitHub" : "文書"}の同期に失敗`, stale: true };
  const last = p.connectors
    .map((c) => (c.lastSuccessAt ? Date.parse(c.lastSuccessAt) : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  if (!last) return { text: "未同期", stale: true };
  const days = Math.floor((Date.now() - last) / DAY);
  return { text: days === 0 ? "今日同期" : `${days} 日前に同期`, stale: days >= 2 };
}

function ProjectSwitcher() {
  const { target, setTarget, label, projects } = useProject();
  const { setOpenMobile } = useSidebar();
  const pick = (value: string) => {
    setTarget(value === "all" ? "" : value);
    setOpenMobile(false);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-sidebar-border bg-card px-3 text-base outline-none hover:bg-accent/50 focus-visible:border-ring data-[state=open]:border-foreground/20 data-[state=open]:bg-card"
        aria-label="見る作業場所"
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-72 p-0"
      >
        <div className="border-b px-3 py-2.5">
          <p className="text-base font-medium">閲覧範囲</p>
          <p className="mt-0.5 text-sm text-muted-foreground">セッション・チャット・会議が引く作業場所</p>
        </div>
        <DropdownMenuRadioGroup value={target || "all"} onValueChange={pick} className="p-1.5">
          <DropdownMenuRadioItem value="all">
            <Layers2Icon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">すべて</span>
            <span className="text-sm text-muted-foreground">セッションの一覧だけ</span>
          </DropdownMenuRadioItem>
          <DropdownMenuGroup className="mt-2 border-t pt-2">
            <DropdownMenuLabel>作業場所</DropdownMenuLabel>
            {projects === undefined && <p className="px-2 py-2 text-sm text-muted-foreground">読み込み中…</p>}
            {projects?.length === 0 && (
              <div className="mx-1 mb-2 rounded-md border border-dashed px-3 py-3">
                <p className="text-sm font-medium">作業場所はまだありません</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  リポジトリで <code className="font-mono">mitos project add</code> を実行します
                </p>
              </div>
            )}
            {projects?.map((project) => {
              const note = syncNote(project);
              return (
                <DropdownMenuRadioItem key={project.id} value={String(project.id)} className="items-start">
                  <GitBranchIcon className="mt-0.5 size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{project.name}</span>
                    <span className={`block text-xs ${note.stale ? "text-dont" : "text-muted-foreground"}`}>
                      {note.text} ・ セッション {project.sessions}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuGroup>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
