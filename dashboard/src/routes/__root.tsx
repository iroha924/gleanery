import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProvider } from "@/lib/project";

const TITLES: [string, string][] = [
  ["/records", "記録"],
  ["/settings", "設定"],
  ["/now", "作業の現在地"],
  ["/mtg", "会議を聞き取る"],
  ["/search", "記録を探す"],
  ["/", "質問する"],
];

/** 幅。**外からは絞らない。**読む幅は画面ごとに違うので、それぞれが自分で決める。 */
function Body() {
  return (
    <div className="w-full flex-1 p-4">
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
