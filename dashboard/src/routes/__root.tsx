import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const TITLES: [string, string][] = [
  ["/records", "作業"],
  ["/projects", "プロジェクト"],
  ["/search", "探す"],
  ["/", "いま"],
];

function Title() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const hit = TITLES.find(([p]) => path.startsWith(p) && p !== "/") ?? TITLES[TITLES.length - 1];
  return <span className="text-sm font-medium">{hit?.[1]}</span>;
}

export const Route = createRootRoute({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Title />
          </header>
          <div className="mx-auto w-full max-w-4xl p-6">
            <Outlet />
          </div>
        </SidebarInset>
        <Toaster />
      </SidebarProvider>
    </TooltipProvider>
  ),
});
