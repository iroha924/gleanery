import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "mitos",
  description: "過去の判断とAIセッションを引くダッシュボード",
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
