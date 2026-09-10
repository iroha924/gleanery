"use client";

import { ClerkLoaded, ClerkLoading, ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Spinner } from "@/components/ui/spinner";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );

  return (
    <ClerkProvider afterSignOutUrl="/sign-in" appearance={{ theme: shadcn }}>
      <ClerkLoading>
        <div className="flex min-h-svh items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      </ClerkLoading>
      <ClerkLoaded>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
