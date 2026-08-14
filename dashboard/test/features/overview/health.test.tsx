import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ApiError } from "../../../src/lib/api";
import { DaemonContractError } from "../../../src/lib/daemon-api";
import { dashboardErrorState, parseDashboardSummaryView, useDashboardHealth } from "../../../src/features/overview/health";

const readySummary = {
  version: "2.0.0-beta",
  environment: "test",
  uptime: "12m",
  accountCount: 2,
  proxyCount: 1,
  apiKeyCount: 1,
  health: { status: "ready", dependencies: { database: "ready" } },
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.restoreAllMocks());

describe("dashboard health states", () => {
  test("keeps explicit ready, degraded, offline, and unknown health values", () => {
    expect(parseDashboardSummaryView(readySummary).health.status).toBe("ready");
    expect(parseDashboardSummaryView({ ...readySummary, health: { status: "degraded", dependencies: { cache: "degraded" } } }).health.status).toBe("degraded");
    expect(parseDashboardSummaryView({ ...readySummary, health: { status: "offline", dependencies: { cache: "offline" } } }).health.status).toBe("offline");
    expect(parseDashboardSummaryView({ version: "2", health: { status: "not-a-state" } }).health.status).toBe("unknown");
  });

  test("distinguishes empty and malformed responses without defaults", () => {
    expect(() => parseDashboardSummaryView({})).toThrowError(new DaemonContractError("empty_response", "dashboard summary is empty", 204));
    expect(() => parseDashboardSummaryView([])).toThrowError(new DaemonContractError("empty_response", "dashboard summary is empty", 204));
    expect(() => parseDashboardSummaryView("invalid")).toThrowError(/invalid/);
    expect(parseDashboardSummaryView({ version: "2" }).accountCount).toBeNull();
  });

  test("maps transport failures to unavailable, degraded, and offline states", () => {
    expect(dashboardErrorState(new ApiError(404, "not_found", "missing"))).toBe("unavailable");
    expect(dashboardErrorState(new ApiError(503, "unavailable", "down"))).toBe("degraded");
    expect(dashboardErrorState(new ApiError(403, "forbidden", "scope"))).toBe("forbidden");
  });

  test("preserves last safe response when a refresh fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(readySummary))
      .mockRejectedValueOnce(new TypeError("network"));
    const { result } = renderHook(() => useDashboardHealth(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    await result.current.refetch();
    await waitFor(() => expect(result.current.state).toBe("offline"));
    expect(result.current.data?.accountCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test("does not let a superseded refresh overwrite the newer response", async () => {
    const superseded = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(readySummary))
      .mockReturnValueOnce(superseded.promise)
      .mockResolvedValueOnce(response({ ...readySummary, health: { status: "degraded", dependencies: { cache: "degraded" } } }));
    const { result } = renderHook(() => useDashboardHealth(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    void result.current.refetch();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    void result.current.refetch();
    await waitFor(() => expect(result.current.state).toBe("degraded"));
    superseded.resolve(response(readySummary));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.state).toBe("degraded");
  });
});
