import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

const TITLES: [string, string][] = [
  ["/records/", "記録"],
  ["/records", "記録"],
  ["/scopes", "作業場所と束"],
  ["/", "検索"],
];

function Title() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const hit = TITLES.find(([p]) => path.startsWith(p) && p !== "/") ?? TITLES[TITLES.length - 1];
  return <span className="text-sm font-medium">{hit?.[1]}</span>;
}

export const Route = createRootRoute({
  component: () => (
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
  ),
});
