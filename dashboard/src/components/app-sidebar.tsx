"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon as StaticChevronRightIcon } from "lucide-react";
import {
  AudioLinesIcon,
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  HistoryIcon,
  Layers2Icon,
  MessageCircleIcon,
  MessagesSquareIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react-motion";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Collapsible } from "radix-ui";
import type * as React from "react";
import { useState } from "react";
import { ConfirmDelete } from "@/components/confirm-delete";
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
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";

const SHOWN = 10;

const NAVIGATION = [
  { href: "/sessions", label: "セッション", icon: MessagesSquareIcon },
  { href: "/", label: "チャット", icon: MessageCircleIcon },
  { href: "/search", label: "ナレッジ検索", icon: SearchIcon },
  { href: "/mtg", label: "MTG録音", icon: AudioLinesIcon },
] as const;

const isCurrent = (path: string, href: string): boolean =>
  href === "/search" ? path === href || path.startsWith("/records") : path === href;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const qc = useQueryClient();
  const router = useRouter();
  const path = usePathname();
  const openChat = useSearchParams().get("chat") || undefined;
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  const { user } = useUser();
  const [showAll, setShowAll] = useState(false);
  const { setOpenMobile } = useSidebar();
  const closeMobile = () => setOpenMobile(false);
  const providerAccount = user?.externalAccounts.find((account) => account.username || account.emailAddress);
  const accountName =
    providerAccount?.username ??
    providerAccount?.emailAddress ??
    user?.username ??
    user?.fullName ??
    user?.primaryEmailAddress?.emailAddress ??
    "アカウント";

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="gap-3 p-2">
        <div className="relative flex h-10 items-center justify-start">
          <Link
            href="/"
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
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isCurrent(path, item.href)} tooltip={item.label}>
                    <Link href={item.href} onClick={closeMobile}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {chats.data && chats.data.length > 0 && (
          <Collapsible.Root defaultOpen className="group/collapsible">
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupLabel asChild>
                <Collapsible.Trigger
                  data-motion-icon-group=""
                  className="gap-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  <HistoryIcon />
                  <span>チャット履歴</span>
                  <StaticChevronRightIcon className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                </Collapsible.Trigger>
              </SidebarGroupLabel>
              <Collapsible.Content>
                <SidebarGroupContent className="ml-3 w-[calc(100%-0.75rem)] pl-2">
                  <SidebarMenu>
                    {chats.data.slice(0, showAll ? undefined : SHOWN).map((chat) => (
                      <SidebarMenuItem key={chat.id}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SidebarMenuButton asChild isActive={path === "/" && openChat === chat.id}>
                              <Link href={`/?chat=${encodeURIComponent(chat.id)}`} onClick={closeMobile}>
                                <MessageCircleIcon />
                                <span>{chat.title ?? "（無題）"}</span>
                              </Link>
                            </SidebarMenuButton>
                          </TooltipTrigger>
                          <TooltipContent side="right">{chat.title ?? "（無題）"}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <ConfirmDelete
                            what={chat.title ?? "この会話"}
                            note="この会話だけが消えます。記録は残ります。"
                            onConfirm={() => {
                              api.deleteChat(chat.id).then(() => {
                                qc.invalidateQueries({ queryKey: ["chats"] });
                                if (openChat === chat.id) router.push("/");
                              });
                            }}
                          >
                            <TooltipTrigger asChild>
                              <SidebarMenuAction showOnHover aria-label="削除する">
                                <Trash2Icon />
                              </SidebarMenuAction>
                            </TooltipTrigger>
                          </ConfirmDelete>
                          <TooltipContent side="right">削除する</TooltipContent>
                        </Tooltip>
                      </SidebarMenuItem>
                    ))}
                    {!showAll && chats.data.length > SHOWN && (
                      <SidebarMenuItem>
                        <SidebarMenuButton className="text-muted-foreground" onClick={() => setShowAll(true)}>
                          <span>履歴をすべて表示</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              </Collapsible.Content>
            </SidebarGroup>
          </Collapsible.Root>
        )}
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={path.startsWith("/settings")} tooltip="設定">
              <Link href="/settings" onClick={closeMobile}>
                <SettingsIcon />
                <span>設定</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex h-10 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <UserButton
            appearance={{
              elements: {
                userButtonTrigger: { width: "2rem", height: "2rem" },
                userButtonAvatarBox: { width: "2rem", height: "2rem" },
              },
            }}
          />
          <span className="truncate text-base group-data-[collapsible=icon]:hidden" title={accountName}>
            {accountName}
          </span>
        </div>
      </SidebarFooter>
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

function ProjectSwitcher() {
  const { target, setTarget, label } = useProject();
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const grouped = new Set(groups.data?.flatMap((group) => group.members.map((member) => member.id)) ?? []);
  const loose = scopes.data?.filter((scope) => !grouped.has(scope.id)) ?? [];
  const { setOpenMobile } = useSidebar();
  const pick = (value: string) => {
    setTarget(value === "all" ? "" : value);
    setOpenMobile(false);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-sidebar-border bg-card px-3 text-base outline-none hover:bg-accent/50 focus-visible:border-ring data-[state=open]:border-foreground/20 data-[state=open]:bg-card"
        aria-label="見るプロジェクト"
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-(--radix-dropdown-menu-trigger-width) p-0"
      >
        <div className="border-b px-3 py-2.5">
          <p className="text-base font-medium">閲覧範囲</p>
          <p className="mt-0.5 text-sm text-muted-foreground">表示するナレッジを切り替えます</p>
        </div>
        <DropdownMenuRadioGroup value={target || "all"} onValueChange={pick} className="p-1.5">
          <DropdownMenuRadioItem value="all">
            <Layers2Icon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">すべて</span>
            <span className="text-sm text-muted-foreground">絞り込みなし</span>
          </DropdownMenuRadioItem>
          <DropdownMenuGroup className="mt-2 border-t py-2">
            <DropdownMenuLabel className="py-2">プロジェクト</DropdownMenuLabel>
            {groups.isPending && <p className="px-2 py-2 text-sm text-muted-foreground">読み込み中…</p>}
            {groups.isError && (
              <p className="px-2 py-2 text-sm text-destructive">プロジェクトを読み込めませんでした</p>
            )}
            {groups.data?.length === 0 && (
              <div className="mx-1 mb-2 rounded-md border border-dashed px-3 py-3">
                <p className="text-sm font-medium">プロジェクトはまだありません</p>
                <p className="mt-1 text-sm text-muted-foreground">設定画面から作成できます</p>
              </div>
            )}
            {groups.data?.map((group) => (
              <DropdownMenuRadioItem key={`g:${group.id}`} value={`g:${group.id}`}>
                <FolderIcon className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                <span className="text-sm tabular-nums text-muted-foreground">{group.members.length}件</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuGroup>
          {loose.length > 0 && (
            <DropdownMenuGroup className="border-t pt-2">
              <DropdownMenuLabel>個別リポジトリ</DropdownMenuLabel>
              {loose.map((scope) => (
                <DropdownMenuRadioItem key={scope.id} value={String(scope.id)}>
                  <GitBranchIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{scope.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
