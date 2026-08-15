/* @jsxImportSource solid-js */

import { afterEach, describe, expect, test, vi } from "vitest";

import { ApiError } from "../../../src/lib/api";
import { ConsoleContractError } from "../../../src/lib/console-api";
import { dashboardErrorState, parseDashboardSummaryView } from "../../../src/features/overview/health";

const readySummary = {
  version: "2.0.0-beta",
  environment: "test",
  uptime: "12m",
  accountCount: 2,
  proxyCount: 1,
  apiKeyCount: 1,
  health: { status: "ready", dependencies: { database: "ready" } },
};

afterEach(() => vi.restoreAllMocks());

describe("dashboard health states", () => {
  test("keeps explicit ready, degraded, offline, and unknown health values", () => {
    expect(parseDashboardSummaryView(readySummary).health.status).toBe("ready");
    expect(parseDashboardSummaryView({ ...readySummary, health: { status: "degraded", dependencies: { cache: "degraded" } } }).health.status).toBe("degraded");
    expect(parseDashboardSummaryView({ ...readySummary, health: { status: "offline", dependencies: { cache: "offline" } } }).health.status).toBe("offline");
    expect(parseDashboardSummaryView({ version: "2", health: { status: "not-a-state" } }).health.status).toBe("unknown");
  });

  test("distinguishes empty and malformed responses without defaults", () => {
    expect(() => parseDashboardSummaryView({})).toThrowError(new ConsoleContractError("empty_response", "dashboard summary is empty", 204));
    expect(() => parseDashboardSummaryView([])).toThrowError(new ConsoleContractError("empty_response", "dashboard summary is empty", 204));
    expect(() => parseDashboardSummaryView("invalid")).toThrowError(/invalid/);
    expect(parseDashboardSummaryView({ version: "2" }).accountCount).toBeNull();
  });

  test("maps transport failures to unavailable, degraded, and offline states", () => {
    expect(dashboardErrorState(new ApiError(404, "not_found", "missing"))).toBe("unavailable");
    expect(dashboardErrorState(new ApiError(503, "unavailable", "down"))).toBe("degraded");
    expect(dashboardErrorState(new ApiError(403, "forbidden", "scope"))).toBe("forbidden");
  });


});
