import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { FolderIcon, ListChecksIcon, PlayIcon, SearchIcon } from "lucide-react";
import type * as React from "react";
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
  const { data: records } = useQuery({ queryKey: ["records"], queryFn: api.records });
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar {...props}>
      <SidebarHeader className="px-3 py-4">
        <Link to="/" className="text-base font-semibold tracking-tight">
          mitos
        </Link>
        <p className="text-xs text-muted-foreground">決めたことを残して、あとで引く</p>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/"}>
                <Link to="/">
                  <PlayIcon /> いま
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/search"}>
                <Link to="/search">
                  <SearchIcon /> 探す
                </Link>
              </SidebarMenuButton>
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
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/records")}>
                <Link to="/records">
                  <ListChecksIcon /> 作業
                </Link>
              </SidebarMenuButton>
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
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
