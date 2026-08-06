import { domAnimation } from "framer-motion";
import { LazyMotion } from "framer-motion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { type ReactNode } from "react";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false, refetchIntervalInBackground: false, gcTime: 5 * 60_000 },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        {/* LazyMotion: ships only ~4.6KB initially, lazy-loads domAnimation
            (~15KB) for exit/layout animations on first use. The `m` component
            replaces `motion` everywhere for tree-shake-friendly bundles. */}
        <LazyMotion features={domAnimation} strict>
          {children}
          <Toaster
            position="top-right"
            offset={{ top: "6rem", right: "1rem" }}
            mobileOffset={{ top: "6rem", left: "1rem", right: "1rem" }}
            visibleToasts={2}
            richColors
            duration={5_000}
            toastOptions={{
              className: "glass-2 select-text",
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
                backdropFilter: "blur(10px) saturate(1.4)",
                userSelect: "text",
              },
            }}
          />
        </LazyMotion>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
