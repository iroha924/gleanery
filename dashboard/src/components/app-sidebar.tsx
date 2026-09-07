import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  HeadphonesIcon,
  ListChecksIcon,
  MessageSquareIcon,
  PlayIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import type * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { scopeIds } = useProject();
  const { data: records } = useQuery({
    queryKey: ["records", scopeIds],
    queryFn: () => api.records(scopeIds),
  });
  const path = useRouterState({ select: (s) => s.location.pathname });

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
              <SidebarMenuButton asChild isActive={path === "/"}>
                <Link to="/">
                  <MessageSquareIcon /> 質問する
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
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

  return (
    <Select value={target} onValueChange={setTarget}>
      <SelectTrigger className="w-full" aria-label="見るプロジェクト">
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">すべて</SelectItem>
        {groups.data && groups.data.length > 0 && (
          <SelectGroup>
            <SelectLabel>プロジェクト</SelectLabel>
            {groups.data.map((g) => (
              <SelectItem key={`g:${g.id}`} value={`g:${g.id}`}>
                {g.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {loose.length > 0 && (
          <SelectGroup>
            <SelectLabel>まとめていないもの</SelectLabel>
            {loose.map((s) => (
              <SelectItem key={s.id} value={String(s.id)}>
                {s.label}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
