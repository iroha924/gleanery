import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // route を作り直す plugin なので react() より前に置く。後ろだと生成前の route tree を変換する。
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routeTreeFileHeader: [
        "/* eslint-disable */",
        "// @ts-nocheck",
        "// noinspection JSUnusedGlobalSymbols",
        "// biome-ignore-all lint: TanStack Router が生成する",
        "// biome-ignore-all format: TanStack Router が生成する",
        "// biome-ignore-all assist: TanStack Router が生成する",
      ],
    }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  // Vite の設定をそのまま使う。alias と plugin を二重に書かない。
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    // **changeOrigin を立てない。**Host をそのまま渡すと Hono が見る origin も Vite の port になり、
    // ブラウザが送る Origin と一致して CSRF を通る。書き換えると両者が食い違って弾かれる。
    // Hono 側は `--dev` で起動したときだけこの port を Host として受け付ける。
    proxy: {
      "/api": { target: "http://127.0.0.1:4924" },
    },
  },
});
