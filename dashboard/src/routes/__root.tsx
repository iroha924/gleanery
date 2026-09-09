import { ClerkLoaded, ClerkLoading, Show, SignIn } from "@clerk/react";
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProvider } from "@/lib/project";

/** 幅。**外からは絞らない。**読む幅は画面ごとに違うので、それぞれが自分で決める。 */
function Body() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const edgeToEdge = path === "/" || path === "/mtg";
  const ownsScroll = edgeToEdge || path === "/now" || path === "/search";

  return (
    <div
      className={`min-h-0 w-full flex-1 ${ownsScroll ? "overflow-hidden" : "overflow-y-auto"} ${
        edgeToEdge ? "" : "p-4 md:px-8 md:py-6"
      }`}
    >
      <Outlet />
    </div>
  );
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
              <div className="app-canvas min-h-svh md:p-3">
                <main className="dashboard-surface flex h-svh flex-col overflow-hidden md:h-[calc(100svh-1.5rem)] md:rounded-[2.75rem]">
                  <AppHeader />
                  <Body />
                </main>
                <Toaster />
              </div>
            </ProjectProvider>
          </TooltipProvider>
        </Show>
      </ClerkLoaded>
    </>
  ),
});
