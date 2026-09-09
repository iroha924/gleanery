import { ClerkLoaded, ClerkLoading, Show, SignIn, UserButton } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
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

/** 画面いっぱいの 1 枚。読み込み中とサインインで同じ枠を使う。 */
function Sheet({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center p-6">{children}</div>;
}

/**
 * サインインするまで画面を出さない。
 *
 * **画面を通しても中身は出ない** — API は 1 経路も認証を免除していないので、
 * ここは体裁の問題であって境界ではない。境界は `server/src/server.ts` にある。
 *
 * **`Show` だけにしない。**あれは読み込み中に null を返すので、Clerk が立ち上がるまで
 * 白い画面になる（実測 1〜3 秒）。壊れて見えるので、その間は `ClerkLoading` が受ける。
 */
export const Route = createRootRoute({
  component: () => (
    <>
      <ClerkLoading>
        <Sheet>
          <Spinner className="size-6 text-muted-foreground" />
        </Sheet>
      </ClerkLoading>
      <ClerkLoaded>
        <Show
          when="signed-in"
          fallback={
            <Sheet>
              <SignIn />
            </Sheet>
          }
        >
          <TooltipProvider delayDuration={300}>
            <ProjectProvider>
              <SidebarProvider>
                <AppSidebar />
                <SidebarInset>
                  <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur md:px-5">
                    <SidebarTrigger className="md:hidden" aria-label="メニューを開く" />
                    <Title />
                    <div className="ml-auto">
                      <UserButton />
                    </div>
                  </header>
                  <Body />
                </SidebarInset>
                <Toaster />
              </SidebarProvider>
            </ProjectProvider>
          </TooltipProvider>
        </Show>
      </ClerkLoaded>
    </>
  ),
});
