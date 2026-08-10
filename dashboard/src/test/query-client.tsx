import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { vi } from "vitest";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

export function withQueryClient(children: ReactNode): ReactElement {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>;
}

export function mockJsonFetch(responses: Readonly<Record<string, unknown>>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = responses[path] ?? { items: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}
