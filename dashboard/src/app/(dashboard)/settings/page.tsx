"use client";

import { useSearchParams } from "next/navigation";
import { ProjectsPanel } from "@/components/settings/projects";
import { TermsPanel } from "@/components/settings/terms";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function SettingsPage() {
  const searchParams = useSearchParams();
  // どのタブを見ていたかを URL に持たせる。再読み込みでも編集中の場所を保つ。
  const tab = searchParams.get("tab") === "terms" ? "terms" : "projects";

  return (
    <div className="mx-auto w-full max-w-[76rem]">
      <Tabs
        value={tab}
        onValueChange={(v) =>
          window.history.pushState(null, "", v === "terms" ? "/settings?tab=terms" : "/settings")
        }
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
