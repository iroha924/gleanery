import { UserButton } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { HistoryIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";

const SHOWN = 10;
const navClass =
  "flex h-10 items-center rounded-full px-3.5 text-sm whitespace-nowrap transition-colors data-active:bg-primary! data-active:text-primary-foreground! hover:bg-muted";

export function AppHeader() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  const openChat = useRouterState({
    select: (s) => (s.location.search as { chat?: string }).chat,
  });
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [showAll, setShowAll] = useState(false);
  const [historyOpen, setHistoryOpen] = useState("");
  const openTitle = openChat ? chats.data?.find((chat) => chat.id === openChat)?.title : null;

  return (
    <header className="relative z-30 shrink-0 p-3 md:px-5">
      <div className="flex min-h-14 w-full flex-wrap items-center gap-2 rounded-[2rem] p-1.5">
        <Link
          to="/"
          search={{}}
          className="flex h-11 shrink-0 items-center gap-2.5 rounded-full px-4 text-lg font-semibold tracking-[-0.025em]"
        >
          <svg viewBox="0 0 16 16" className="size-5" fill="none" aria-hidden="true">
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
          mitos
        </Link>

        <nav className="order-last w-full overflow-x-auto md:order-none md:mx-auto md:w-auto md:overflow-visible">
          <div className="flex w-max items-center gap-0.5 rounded-full bg-white/60 p-1 text-[var(--brand-black)] backdrop-blur-xl">
            <Link to="/now" className={navClass} data-active={path === "/now" || undefined}>
              現在地
            </Link>
            <Link to="/" search={{}} className={navClass} data-active={path === "/" || undefined}>
              チャット
            </Link>
            <Link
              to="/search"
              className={navClass}
              data-active={path === "/search" || path.startsWith("/records") || undefined}
            >
              ナレッジ検索
            </Link>
            <Link to="/mtg" className={navClass} data-active={path === "/mtg" || undefined}>
              MTG録音
            </Link>
          </div>
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 md:ml-0">
          <div className="hidden w-72 sm:block">
            <ProjectSwitcher />
          </div>

          {chats.data && chats.data.length > 0 && (
            <NavigationMenu value={historyOpen} onValueChange={setHistoryOpen} viewport={false}>
              <NavigationMenuList>
                <NavigationMenuItem value="history">
                  <NavigationMenuTrigger className="h-10 max-w-48 rounded-full bg-card/60 px-3 font-normal backdrop-blur-xl">
                    <HistoryIcon className="size-4" />
                    <span className="max-w-28 truncate">{openTitle ?? "チャット履歴"}</span>
                  </NavigationMenuTrigger>
                  <NavigationMenuContent className="fixed! top-16! right-4! left-4! z-50 w-auto! p-2 shadow-none sm:absolute! sm:top-full! sm:right-0! sm:left-auto! sm:w-80!">
                    <div className="max-h-96 space-y-1 overflow-y-auto">
                      {chats.data.slice(0, showAll ? undefined : SHOWN).map((chat) => (
                        <div key={chat.id} className="group/history relative">
                          <NavigationMenuLink asChild active={path === "/" && openChat === chat.id}>
                            <Link
                              to="/"
                              search={{ chat: chat.id }}
                              onClick={() => setHistoryOpen("")}
                              className="block min-w-0 pr-9"
                            >
                              <span className="block truncate">{chat.title ?? "（無題）"}</span>
                              <time
                                dateTime={chat.updated_at}
                                className="mt-0.5 block text-xs text-muted-foreground tabular-nums"
                              >
                                {chat.updated_at.slice(0, 10)}
                              </time>
                            </Link>
                          </NavigationMenuLink>
                          <ConfirmDelete
                            what={chat.title ?? "この会話"}
                            note="この会話だけが消えます。記録は残ります。"
                            onConfirm={() => {
                              api.deleteChat(chat.id).then(() => {
                                qc.invalidateQueries({ queryKey: ["chats"] });
                                if (openChat === chat.id) navigate({ to: "/", search: {} });
                              });
                            }}
                          >
                            <button
                              type="button"
                              aria-label={`「${chat.title ?? "この会話"}」を消す`}
                              className="absolute top-1.5 right-1.5 rounded-full p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-focus-within/history:opacity-100 group-hover/history:opacity-100"
                            >
                              <Trash2Icon className="size-3.5" />
                            </button>
                          </ConfirmDelete>
                        </div>
                      ))}
                      {!showAll && chats.data.length > SHOWN && (
                        <button
                          type="button"
                          onClick={() => setShowAll(true)}
                          className="w-full rounded-lg px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
                        >
                          ほか {chats.data.length - SHOWN} 件
                        </button>
                      )}
                    </div>
                  </NavigationMenuContent>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
          )}

          <Link
            to="/settings"
            aria-label="設定"
            className={`flex size-10 shrink-0 items-center justify-center rounded-full backdrop-blur-xl transition ${
              path.startsWith("/settings")
                ? "bg-primary text-primary-foreground hover:bg-primary"
                : "bg-card/60 hover:bg-muted"
            }`}
          >
            <SettingsIcon className="size-4" />
          </Link>
          <UserButton
            appearance={{
              elements: {
                userButtonTrigger: { width: "2.5rem", height: "2.5rem" },
                userButtonAvatarBox: { width: "2.5rem", height: "2.5rem" },
              },
            }}
          />
        </div>

        <div className="w-full sm:hidden">
          <ProjectSwitcher />
        </div>
      </div>
    </header>
  );
}

function ProjectSwitcher() {
  const { target, setTarget, label } = useProject();
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const grouped = new Set(groups.data?.flatMap((group) => group.members.map((member) => member.id)) ?? []);
  const loose = scopes.data?.filter((scope) => !grouped.has(scope.id)) ?? [];
  const [open, setOpen] = useState("");
  const pick = (value: string) => {
    setTarget(value);
    setOpen("");
  };
  const Row = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <NavigationMenuLink
      active={target === value}
      onClick={() => pick(value)}
      className="cursor-pointer whitespace-nowrap rounded-lg px-3 py-2 text-sm"
    >
      {children}
    </NavigationMenuLink>
  );

  return (
    <NavigationMenu
      value={open}
      onValueChange={setOpen}
      viewport={false}
      className="w-full max-w-none [&>div]:w-full"
    >
      <NavigationMenuList className="w-full">
        <NavigationMenuItem value="project" className="w-full">
          <NavigationMenuTrigger
            className="h-10 w-full justify-between rounded-full bg-card/60 px-3 font-normal text-sm backdrop-blur-xl hover:bg-muted data-[state=open]:bg-muted"
            aria-label="見るプロジェクト"
          >
            <span className="truncate">{label}</span>
          </NavigationMenuTrigger>
          <NavigationMenuContent className="absolute left-0 z-50 w-full! p-2 shadow-none">
            <Row value="">すべて</Row>
            {groups.data && groups.data.length > 0 && (
              <>
                <Marker className="px-2 pt-2.5 pb-1 text-xs">
                  <MarkerContent>プロジェクト</MarkerContent>
                </Marker>
                {groups.data.map((group) => (
                  <Row key={`g:${group.id}`} value={`g:${group.id}`}>
                    {group.name}
                  </Row>
                ))}
              </>
            )}
            {loose.length > 0 && (
              <>
                <Marker className="px-2 pt-2.5 pb-1 text-xs">
                  <MarkerContent>まとめていないもの</MarkerContent>
                </Marker>
                {loose.map((scope) => (
                  <Row key={scope.id} value={String(scope.id)}>
                    {scope.label}
                  </Row>
                ))}
              </>
            )}
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
