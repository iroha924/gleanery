import { useRouterState } from "@tanstack/react-router";
import { cn } from "cn";
import { MotionIconConfig } from "lucide-react-motion";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProvider } from "@/lib/project";

/** 幅。**外からは絞らない。**読む幅は画面ごとに違うので、それぞれが自分で決める。 */
function Body({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const edgeToEdge = path === "/" || path === "/mtg";
  const ownsScroll = edgeToEdge || path === "/sessions";

  return (
    <div
      className={cn(
        "min-h-0 w-full flex-1 bg-card",
        ownsScroll ? "overflow-hidden" : "overflow-y-auto",
        !edgeToEdge && "px-4 pt-14 pb-4 md:p-6 lg:p-8",
      )}
    >
      {children}
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <MotionIconConfig mode="signature" trigger="parent-hover" onLeave="snap" duration={0.4} stagger={0.08}>
      <TooltipProvider delayDuration={300}>
        <ProjectProvider>
          <SidebarProvider className="app-canvas min-h-svh">
            <AppSidebar />
            <SidebarInset className="h-svh min-w-0 overflow-hidden bg-card">
              <SidebarTrigger className="absolute top-3 left-3 z-30 rounded-md border bg-card/85 backdrop-blur-xl md:hidden" />
              <Body>{children}</Body>
            </SidebarInset>
            <Toaster />
          </SidebarProvider>
        </ProjectProvider>
      </TooltipProvider>
    </MotionIconConfig>
  );
}
