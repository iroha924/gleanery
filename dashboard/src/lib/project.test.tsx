import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ProjectProvider, useProject } from "./project";

/** 作業場所の一覧だけを差し替える。ほかの経路は呼ばせない。 */
function mount(fetcher: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(fetcher));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe() {
    const { failed, projects } = useProject();
    return (
      <>
        <span data-testid="failed">{failed ?? ""}</span>
        <span data-testid="count">{projects === undefined ? "-" : String(projects.length)}</span>
      </>
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <ProjectProvider>
        <Probe />
      </ProjectProvider>
    </QueryClientProvider>,
  );
}

// **失敗を「読み込み中」に見せない。**取れていないのに待たせ続けると、利用者は待てば直ると思う。
test("一覧が引けなければ、理由を失敗として渡す", async () => {
  mount(() => Promise.resolve(new Response("boom", { status: 500 })));
  const failed = await screen.findByTestId("failed");
  await expect.poll(() => failed.textContent).not.toBe("");
  expect(failed.textContent).toMatch(/500|読めなかった|引けなかった/);
});

test("引けたときは失敗を渡さない", async () => {
  mount(() =>
    Promise.resolve(
      new Response(
        JSON.stringify([{ id: 1, key: "git:x/y", name: "y", sessions: 0, knowledge: 0, connectors: [] }]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ),
  );
  const count = await screen.findByTestId("count");
  await expect.poll(() => count.textContent).toBe("1");
  expect(screen.getByTestId("failed").textContent).toBe("");
});
