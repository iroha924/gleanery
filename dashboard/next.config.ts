import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // ローカルの外部 rewrite で SSE を圧縮すると、応答が完了するまでブラウザへ流れない。
  compress: Boolean(process.env.VERCEL),
  experimental: {
    // 文字起こしは応答開始まで 30 秒を超えることがある。
    proxyTimeout: 300_000,
    // Hono は音声ファイルを 25,000,000 bytes まで受ける。multipart の境界を含む余裕を足す。
    proxyClientMaxBodySize: "26mb",
  },
  async rewrites() {
    if (process.env.VERCEL) return [];
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8787/api/:path*",
      },
    ];
  },
};

export default nextConfig;
