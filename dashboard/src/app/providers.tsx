import { MotionConfig } from "framer-motion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { type ReactNode } from "react";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <MotionConfig reducedMotion="user">
          {children}
          <Toaster
            position="bottom-right"
            gap={10}
            toastOptions={{
              className: "glass-2",
              style: {
                background: "var(--glass-bg-2)",
                border: "1px solid var(--glass-border-2)",
                color: "var(--text-1)",
                backdropFilter: "blur(24px) saturate(1.6)",
              },
            }}
          />
        </MotionConfig>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
