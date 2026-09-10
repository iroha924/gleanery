"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProvider } from "@/lib/project";

/** 幅。**外からは絞らない。**読む幅は画面ごとに違うので、それぞれが自分で決める。 */
function Body({ children }: { children: ReactNode }) {
  const path = usePathname();
  const edgeToEdge = path === "/" || path === "/mtg";
  const ownsScroll = edgeToEdge || path === "/now" || path === "/search";

  return (
    <div
      className={`min-h-0 w-full flex-1 ${ownsScroll ? "overflow-hidden" : "overflow-y-auto"} ${
        edgeToEdge ? "" : "p-4 md:px-8 md:py-6"
      }`}
    >
      {children}
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <ProjectProvider>
        <div className="app-canvas min-h-svh md:p-3">
          <main className="dashboard-surface flex h-svh flex-col overflow-hidden md:h-[calc(100svh-1.5rem)] md:rounded-[2.75rem]">
            <AppHeader />
            <Body>{children}</Body>
          </main>
          <Toaster />
        </div>
      </ProjectProvider>
    </TooltipProvider>
  );
}
