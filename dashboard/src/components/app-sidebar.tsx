import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  HeadphonesIcon,
  ListChecksIcon,
  MessageSquareIcon,
  PlayIcon,
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
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";

/** 履歴に常に出す件数。これを超えたぶんは畳む。 */
const SHOWN = 10;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { scopeIds } = useProject();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  // いま開いている会話。URL が持っているので、画面をまたいでも一致する。
  const openChat = useRouterState({
    select: (s) => (s.location.search as { chat?: string }).chat,
  });
  const { data: records } = useQuery({
    queryKey: ["records", scopeIds],
    queryFn: () => api.records(scopeIds),
  });
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [showAll, setShowAll] = useState(false);

  return (
    <Sidebar {...props}>
      <SidebarHeader className="gap-3 px-3 py-4">
        <Link to="/" className="text-base font-semibold tracking-tight">
          mitos
        </Link>
        {/* **いま何を見ているかは 1 箇所で決める。**全画面がこれに従う。 */}
        <ProjectSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/now"}>
                <Link to="/now">
                  <PlayIcon /> 作業の現在地
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              {/* 会話を開いている間は光らせない。**下の履歴と二重に光ると、いまどれを読んで
                  いるのかが読めなくなる。**押せば新しい会話へ戻る、はそのまま効く。 */}
              <SidebarMenuButton asChild isActive={path === "/" && !openChat}>
                <Link to="/" search={{}}>
                  <MessageSquareIcon /> 質問する
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* **履歴はここに置く。**会話は画面ではなく道具の状態なので、本文の上に
                切り替え役を置くと、読んでいる最中に目に入り続ける。 */}
            {chats.data && chats.data.length > 0 && (
              <SidebarMenuItem>
                <SidebarMenuSub>
                  {chats.data.slice(0, showAll ? undefined : SHOWN).map((h) => (
                    <SidebarMenuSubItem key={h.id} className="group/chat relative">
                      <SidebarMenuSubButton asChild isActive={path === "/" && openChat === h.id}>
                        <Link to="/" search={{ chat: h.id }}>
                          <span className="truncate pr-5">{h.title ?? "（無題）"}</span>
                        </Link>
                      </SidebarMenuSubButton>
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
                          className="absolute top-1 right-1 rounded-md p-1 text-sidebar-foreground/50 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/chat:opacity-100"
                        >
                          <Trash2Icon className="size-3" />
                        </button>
                      </ConfirmDelete>
                    </SidebarMenuSubItem>
                  ))}
                  {/* **古い会話は畳む。**全部並べると、下にある「会議を聞き取る」「記録を探す」が
                      画面外へ押し出される。押せば残りも出る。 */}
                  {!showAll && chats.data.length > SHOWN && (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton onClick={() => setShowAll(true)}>
                        <span className="text-sidebar-foreground/60">
                          ほか {chats.data.length - SHOWN} 件
                        </span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  )}
                </SidebarMenuSub>
              </SidebarMenuItem>
            )}

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/mtg"}>
                <Link to="/mtg">
                  <HeadphonesIcon /> 会議を聞き取る
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/search"}>
                <Link to="/search">
                  <SearchIcon /> 記録を探す
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              {/* **押せる要素にしない。**ここは下の一覧の見出しで、それ自体に行き先が無い。
                  リンクにしていたときは /now へ飛ぶのに /records で光っていて、押した先と
                  光る条件が食い違っていた。 */}
              <div className="flex h-8 items-center gap-2 px-2 font-medium text-sidebar-foreground/70 text-xs">
                <ListChecksIcon className="size-4" /> 記録
              </div>
              {records && records.length > 0 && (
                <SidebarMenuSub>
                  {records.slice(0, 8).map((r) => (
                    <SidebarMenuSubItem key={r.id}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <SidebarMenuSubButton asChild isActive={path === `/records/${r.id}`}>
                            <Link to="/records/$id" params={{ id: r.id }}>
                              <span className="truncate">{r.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </TooltipTrigger>
                        {/* 幅に収まらず … で切れるので、全文はホバーで読めるようにする */}
                        <TooltipContent side="right" className="max-w-xs">
                          {r.title}
                        </TooltipContent>
                      </Tooltip>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>設定</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/settings")}>
                <Link to="/settings">
                  <SettingsIcon /> 設定
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
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
