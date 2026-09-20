import { createRootRoute, Outlet } from "@tanstack/react-router";
import { DashboardShell } from "@/components/dashboard-shell";
import { RouteFailed, RouteMissing } from "@/components/route-failed";

export const Route = createRootRoute({
  component: () => (
    <DashboardShell>
      <Outlet />
    </DashboardShell>
  ),
  // 描画中に投げた例外の受け皿。無いと白い画面だけが残る。
  errorComponent: RouteFailed,
  notFoundComponent: RouteMissing,
});
