import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProvider } from "@/lib/project";

const TITLES: [string, string][] = [
  ["/records", "作業"],
  ["/projects", "プロジェクトの設定"],
  ["/people", "人"],
  ["/terms", "言葉"],
  ["/chat", "聞く"],
  ["/search", "探す"],
  ["/", "いま"],
];

/** 幅。**地図の画面だけ全幅にする** — 読む幅（max-w-4xl）に入れると地図が 270px まで潰れた（実測）。 */
function Body() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const wide = path.startsWith("/chat") || path.startsWith("/search");
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
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 h-4" />
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
