import { useQuery } from "@tanstack/react-query";
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
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
  const chatId = useRouterState({ select: (s) => (s.location.search as { chat?: string }).chat });
  // サイドバーが引いているのと同じ問い合わせなので、ここで足しても往復は増えない。
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  const hit = TITLES.find(([p]) => path.startsWith(p) && p !== "/") ?? TITLES[TITLES.length - 1];
  // **会話を開いているときは会話の題を出す。**どの会話を読んでいるのかが、
  // 画面のどこにも出ていなかった。
  const open = chatId ? chats.data?.find((x) => x.id === chatId)?.title : null;
  return <span className="truncate text-sm font-medium">{open ?? hit?.[1]}</span>;
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
