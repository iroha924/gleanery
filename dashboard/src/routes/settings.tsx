import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ProjectsPanel } from "@/components/settings/projects";
import { TermsPanel } from "@/components/settings/terms";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Search = { tab?: "projects" | "terms" };

export const Route = createFileRoute("/settings")({
  component: Settings,
  // **どのタブを見ていたかを URL に持たせる。**再読み込みで先頭へ戻ると、
  // 辞書を直している途中に毎回プロジェクトへ飛ばされる。
  validateSearch: (s: Record<string, unknown>): Search => (s.tab === "terms" ? { tab: "terms" } : {}),
});

function Settings() {
  const { tab } = Route.useSearch();
  const nav = useNavigate({ from: Route.fullPath });

  return (
    <div className="mx-auto w-full max-w-[76rem] space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">記録をまとめる単位と、固有の言葉を管理します。</p>
      </header>
      <Tabs
        value={tab ?? "projects"}
        onValueChange={(v) => nav({ search: v === "terms" ? { tab: "terms" } : {} })}
      >
        <TabsList variant="line" className="mb-6">
          <TabsTrigger value="projects">プロジェクト</TabsTrigger>
          <TabsTrigger value="terms">社内語の辞書</TabsTrigger>
        </TabsList>
        <TabsContent value="projects">
          <ProjectsPanel />
        </TabsContent>
        <TabsContent value="terms">
          <TermsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
