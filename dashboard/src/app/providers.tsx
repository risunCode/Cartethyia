import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { type ReactNode } from "react";

import { useMotionProfile } from "../lib/motion";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false, refetchIntervalInBackground: false, gcTime: 5 * 60_000 },
  },
});

function MotionProfileSync() {
  useMotionProfile();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <MotionProfileSync />
        {children}
        <Toaster
          position="top-right"
          offset={{ top: "6rem", right: "1rem" }}
          mobileOffset={{ top: "6rem", left: "1rem", right: "1rem" }}
          visibleToasts={2}
          richColors
          duration={5_000}
          toastOptions={{
            className: "toast-surface select-text",
            descriptionClassName: "select-text text-[var(--text-2)]",
            classNames: {
              title: "select-text text-[13px] font-semibold",
            },
            actionButtonStyle: {
              background: "var(--accent)",
              color: "var(--accent-foreground)",
            },
            cancelButtonStyle: {
              background: "var(--surface-muted)",
              color: "var(--text-1)",
            },
            style: {
              background: "var(--glass-bg-2)",
              border: "1px solid var(--glass-border-2)",
              color: "var(--text-1)",
              userSelect: "text",
            },
          }}
        />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
