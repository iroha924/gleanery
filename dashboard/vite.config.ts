import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // **router を react より前に置く。**公式が名指しで要求している唯一の順序制約
    // （"Please make sure that '@tanstack/router-plugin' is passed before '@vitejs/plugin-react'"）。
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    // React Compiler。plugin-react 6 は Babel ではなく oxc の実装を持つ
    // （型定義: "Enable React Compiler with its default options... requires `oxc-transform-react`"）。
    react({ compiler: true }),
    tailwindcss(),
  ],
  // shadcn/ui は "@/..." で自分のファイルを参照する。tsconfig の paths と揃える。
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    // 資格情報を持つのは API だけ。画面は同一オリジンで叩けるようにする。
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
