import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProvider } from "@/lib/project";

const TITLES: [string, string][] = [
  ["/records", "記録"],
  ["/projects", "プロジェクトの設定"],
  ["/people", "名簿"],
  ["/terms", "社内語の辞書"],
  ["/now", "作業の現在地"],
  ["/advice", "編集時の助言"],
  ["/mtg", "会議を聞き取る"],
  ["/search", "記録を探す"],
  ["/", "質問する"],
];

/** 幅。**会話と検索だけ全幅にする** — 中で自分の読む幅を持っているので、外から max-w をかけると二重に狭まる。 */
function Body() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const wide =
    path === "/" || path.startsWith("/chat") || path.startsWith("/search") || path.startsWith("/mtg");
  return (
    <div className={wide ? "w-full flex-1 p-4" : "mx-auto w-full max-w-4xl p-6"}>
      <Outlet />
    </div>
  );
}

function Title() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const hit = TITLES.find(([p]) => path.startsWith(p) && p !== "/") ?? TITLES[TITLES.length - 1];
  return <span className="text-sm font-medium">{hit?.[1]}</span>;
}

export const Route = createRootRoute({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <ProjectProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <Title />
            </header>
            <Body />
          </SidebarInset>
          <Toaster />
        </SidebarProvider>
      </ProjectProvider>
    </TooltipProvider>
  ),
});
