import { auth } from "@clerk/nextjs/server";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 画面の門は体裁で、データの認証境界はすべての API を守る Hono 側にある。
  await auth.protect();
  return <DashboardShell>{children}</DashboardShell>;
}
