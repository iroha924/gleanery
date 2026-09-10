import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware({ signInUrl: "/sign-in" });

export const config = {
  // /api は Hono 自身が Authorization JWT を検証する。静的ファイルは Clerk を通さない。
  matcher: [
    "/((?!api(?:/|$)|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
