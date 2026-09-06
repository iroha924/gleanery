import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { BanIcon, FolderTreeIcon, LayersIcon, SearchIcon, SpoolIcon } from "lucide-react";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";

// 種別ごとの入口はサブメニューに置く。検索の絞り込みは URL に載るので、
// ここから入ってもブックマークでき、戻るボタンも効く。
const KIND_LINKS = [
  { kind: "decision", label: "決定" },
  { kind: "option", label: "検討した案" },
  { kind: "event", label: "経過・行き止まり" },
  { kind: "boundary", label: "制約・やらないこと" },
  { kind: "verification", label: "検証" },
  { kind: "question", label: "未解決の問い" },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const { data: records } = useQuery({ queryKey: ["records"], queryFn: api.records });
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <SpoolIcon className="size-4" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-medium">mitos</span>
                  <span className="text-xs tabular-nums">{stats ? `${stats.nodes} 件の判断` : "…"}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/"}>
                <Link to="/">
                  <SearchIcon /> 検索
                </Link>
              </SidebarMenuButton>
              <SidebarMenuSub>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild>
                    <Link to="/" search={{ dont: true }}>
                      <BanIcon className="size-3.5" /> やらない・棄却・行き止まり
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
                {KIND_LINKS.map((k) => (
                  <SidebarMenuSubItem key={k.kind}>
                    <SidebarMenuSubButton asChild>
                      <Link to="/" search={{ kinds: [k.kind] }}>
                        {k.label}
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/records")}>
                <Link to="/records">
                  <LayersIcon /> 記録
                </Link>
              </SidebarMenuButton>
              {records && records.length > 0 && (
                <SidebarMenuSub>
                  {records.slice(0, 8).map((r) => (
                    <SidebarMenuSubItem key={r.id}>
                      <SidebarMenuSubButton asChild isActive={path === `/records/${r.id}`}>
                        <Link to="/records/$id" params={{ id: r.id }}>
                          <span className="truncate">{r.title}</span>
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              )}
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/scopes")}>
                <Link to="/scopes">
                  <FolderTreeIcon /> 作業場所と束
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
