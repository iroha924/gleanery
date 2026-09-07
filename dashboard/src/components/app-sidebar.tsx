import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BellIcon,
  BookOpenIcon,
  ChevronRightIcon,
  FolderIcon,
  HeadphonesIcon,
  ListChecksIcon,
  MessageSquareIcon,
  PlayIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import type * as React from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  SidebarMenuAction,
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

// 種別の呼び名は、内部の kind ではなく人が言う言葉にする。
const KINDS = [
  { kind: "decision", label: "決めたこと" },
  { kind: "option", label: "検討した案" },
  { kind: "event", label: "分かったこと" },
  { kind: "boundary", label: "触らない制約" },
  { kind: "verification", label: "確かめたこと" },
  { kind: "question", label: "未解決の問い" },
] as const;

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
              <SidebarMenuButton asChild isActive={path === "/advice"}>
                <Link to="/advice">
                  <BellIcon /> 編集時の助言
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {/* **種別は畳んでおく。**7 つ常時出ていると、上の 4 つと同じ重さに見えてしまう。 */}
            <Collapsible className="group/kinds">
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={path === "/search"}>
                  <Link to="/search">
                    <SearchIcon /> 記録を探す
                  </Link>
                </SidebarMenuButton>
                <CollapsibleTrigger asChild>
                  <SidebarMenuAction className="transition-transform group-data-[state=open]/kinds:rotate-90">
                    <ChevronRightIcon />
                    <span className="sr-only">種別で絞る</span>
                  </SidebarMenuAction>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton asChild>
                        <Link to="/search" search={{ dont: true }}>
                          <span className="truncate">やらないこと</span>
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    {KINDS.map((k) => (
                      <SidebarMenuSubItem key={k.kind}>
                        <SidebarMenuSubButton asChild>
                          <Link to="/search" search={{ kinds: [k.kind] }}>
                            <span className="truncate">{k.label}</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>

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
              <SidebarMenuButton asChild isActive={path.startsWith("/projects")}>
                <Link to="/projects">
                  <FolderIcon /> プロジェクト
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/terms")}>
                <Link to="/terms">
                  <BookOpenIcon /> 社内語の辞書
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/people")}>
                <Link to="/people">
                  <UsersIcon /> 名簿
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
