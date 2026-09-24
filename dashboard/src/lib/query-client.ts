import { QueryClient } from "@tanstack/react-query";

/**
 * One application-wide server-state cache for the dashboard.
 * Reads keep a short freshness window while mutations never retry silently.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 120_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
