import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  HeadphonesIcon,
  MessageSquareIcon,
  OrbitIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";

/** 履歴に常に出す件数。これを超えたぶんは畳む。 */
const SHOWN = 10;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  // いま開いている会話。URL が持っているので、画面をまたいでも一致する。
  const openChat = useRouterState({
    select: (s) => (s.location.search as { chat?: string }).chat,
  });
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [showAll, setShowAll] = useState(false);
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="gap-4 px-3 pt-4 pb-3">
        <Link
          to="/"
          onClick={closeMobile}
          className="flex items-center gap-2 px-1 text-[15px] font-semibold tracking-[-0.02em]"
        >
          {/* 折り返す糸。**ファビコンと同じ形をそのまま置く** — 色は currentColor に任せるので、
              明暗の切り替えでも文字と同じ濃さで並ぶ。 */}
          <svg viewBox="0 0 16 16" className="size-[18px] flex-none" fill="none" aria-hidden="true">
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
        <div className="space-y-1.5">
          <p className="px-1 text-[11px] font-medium tracking-wide text-sidebar-foreground/55">
            表示する範囲
          </p>
          {/* **いま何を見ているかは 1 箇所で決める。**全画面がこれに従う。 */}
          <ProjectSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>ワークスペース</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={path === "/now"}
                className="data-active:text-sidebar-primary"
              >
                <Link to="/now" onClick={closeMobile}>
                  <OrbitIcon /> 作業の現在地
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              {/* 会話を開いている間は光らせない。**下の履歴と二重に光ると、いまどれを読んで
                  いるのかが読めなくなる。**押せば新しい会話へ戻る、はそのまま効く。 */}
              <SidebarMenuButton
                asChild
                isActive={path === "/" && !openChat}
                className="data-active:text-sidebar-primary"
              >
                <Link to="/" search={{}} onClick={closeMobile}>
                  <MessageSquareIcon /> 質問する
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={path === "/search" || path.startsWith("/records")}
                className="data-active:text-sidebar-primary"
              >
                <Link to="/search" onClick={closeMobile}>
                  <SearchIcon /> 記録を探す
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={path === "/mtg"}
                className="data-active:text-sidebar-primary"
              >
                <Link to="/mtg" onClick={closeMobile}>
                  <HeadphonesIcon /> 会議を聞き取る
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* **会話の履歴は移動の一覧と分ける。**見出しがあると、機能と過去の状態を混同しない。 */}
        {chats.data && chats.data.length > 0 && (
          <SidebarGroup className="pt-1">
            <SidebarGroupLabel>最近の会話</SidebarGroupLabel>
            <SidebarMenu>
              {chats.data.slice(0, showAll ? undefined : SHOWN).map((h) => (
                <SidebarMenuItem key={h.id} className="group/chat">
                  <SidebarMenuButton
                    asChild
                    isActive={path === "/" && openChat === h.id}
                    className="pr-8 data-active:text-sidebar-primary"
                  >
                    <Link to="/" search={{ chat: h.id }} onClick={closeMobile}>
                      <span className="truncate">{h.title ?? "（無題）"}</span>
                    </Link>
                  </SidebarMenuButton>
                  <ConfirmDelete
                    what={h.title ?? "この会話"}
                    note="この会話だけが消えます。記録は残ります。"
                    onConfirm={() => {
                      api.deleteChat(h.id).then(() => {
                        qc.invalidateQueries({ queryKey: ["chats"] });
                        if (openChat === h.id) navigate({ to: "/", search: {} });
                      });
                    }}
                  >
                    <button
                      type="button"
                      aria-label={`「${h.title ?? "この会話"}」を消す`}
                      className="absolute top-1.5 right-1.5 rounded-md p-1 text-sidebar-foreground/45 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground group-focus-within/chat:opacity-100 group-hover/chat:opacity-100"
                    >
                      <Trash2Icon className="size-3" />
                    </button>
                  </ConfirmDelete>
                </SidebarMenuItem>
              ))}
              {!showAll && chats.data.length > SHOWN && (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => setShowAll(true)} className="text-sidebar-foreground/60">
                    ほか {chats.data.length - SHOWN} 件
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border px-2 py-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={path.startsWith("/settings")}
              className="data-active:text-sidebar-primary"
            >
              <Link to="/settings" onClick={closeMobile}>
                <SettingsIcon /> 設定
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * いま開いているプロジェクトの切り替え。
 *
 * **プロジェクト（束）だけでなく、どこにも属していないリポジトリも並べる。**
 * そうしないと、束ねていないものが画面から一生見えなくなる。
 */
function ProjectSwitcher() {
  const { target, setTarget, label } = useProject();
  const { isMobile, setOpenMobile } = useSidebar();
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const grouped = new Set(groups.data?.flatMap((g) => g.members.map((m) => m.id)) ?? []);
  const loose = scopes.data?.filter((s) => !grouped.has(s.id)) ?? [];

  // **選んだら閉じる。**NavigationMenu は行き先を持つリンクを前提にしていて、遷移しない
  // リンクを押しても開いたままになる。開閉を自分で持たないと、選んだ後も一覧が居座る。
  const [open, setOpen] = useState("");
  const pick = (v: string) => {
    setTarget(v);
    setOpen("");
    if (isMobile) setOpenMobile(false);
  };
  const Row = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <NavigationMenuLink
      active={target === value}
      onClick={() => pick(value)}
      className="cursor-pointer truncate rounded-md px-2 py-1.5 text-sm"
    >
      {children}
    </NavigationMenuLink>
  );

  return (
    <NavigationMenu value={open} onValueChange={setOpen} className="w-full max-w-none [&>div]:w-full">
      <NavigationMenuList className="w-full">
        <NavigationMenuItem value="project" className="w-full">
          <NavigationMenuTrigger
            className="h-9 w-full justify-between border bg-transparent px-3 font-normal text-sm"
            aria-label="見るプロジェクト"
          >
            <span className="truncate">{label}</span>
          </NavigationMenuTrigger>
          <NavigationMenuContent className="w-[15rem] p-1.5">
            <Row value="">すべて</Row>
            {groups.data && groups.data.length > 0 && (
              <>
                <Marker className="px-2 pt-2.5 pb-1 text-[11px]">
                  <MarkerContent>プロジェクト</MarkerContent>
                </Marker>
                {groups.data.map((g) => (
                  <Row key={`g:${g.id}`} value={`g:${g.id}`}>
                    {g.name}
                  </Row>
                ))}
              </>
            )}
            {loose.length > 0 && (
              <>
                <Marker className="px-2 pt-2.5 pb-1 text-[11px]">
                  <MarkerContent>まとめていないもの</MarkerContent>
                </Marker>
                {loose.map((s) => (
                  <Row key={s.id} value={String(s.id)}>
                    {s.label}
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
