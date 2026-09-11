import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 画面の門は体裁で、データの認証境界はすべての API を守る Hono 側にある。
  await auth.protect();
  const defaultSidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  return <DashboardShell defaultSidebarOpen={defaultSidebarOpen}>{children}</DashboardShell>;
}
