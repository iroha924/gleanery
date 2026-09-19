import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  server: {
    host: "127.0.0.1",
    strictPort: true,
    // changeOrigin を立てない。Host を書き換えると、Hono 側の origin 検査と食い違う。
    proxy: {
      "/api": { target: "http://127.0.0.1:8787" },
    },
  },
});
