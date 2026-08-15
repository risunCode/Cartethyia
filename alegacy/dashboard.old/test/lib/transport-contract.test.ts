import { afterEach, describe, expect, test, vi } from "vitest";
import { api, type DaemonHttpMethod } from "../../src/lib/api";
import { daemonFailure, daemonGet, DaemonContractError } from "../../src/lib/daemon-api";
import {
  DAEMON_ROUTE_MATRIX,
  findDaemonRouteContract,
  isDocumentedDaemonRoute,
  serializeDaemonQuery,
} from "../../src/lib/daemon-routes";

describe("dashboard transport route contract", () => {
  afterEach(() => vi.restoreAllMocks());

  test("checks every retained route against standard methods only", () => {
    expect(DAEMON_ROUTE_MATRIX.length).toBeGreaterThan(0);
    for (const contract of DAEMON_ROUTE_MATRIX) {
      expect(contract.route.startsWith("/v2/")).toBe(false);
      expect(contract.methods.every((method): method is DaemonHttpMethod => ["GET", "POST", "PATCH", "DELETE"].includes(method))).toBe(true);
      expect(contract.methods).not.toContain("QUERY");
    }
    expect(isDocumentedDaemonRoute("/settings", "GET")).toBe(true);
    expect(isDocumentedDaemonRoute("/settings", "PATCH")).toBe(true);
    expect(isDocumentedDaemonRoute("/settings", "POST")).toBe(true);
    expect(isDocumentedDaemonRoute("/settings", "DELETE")).toBe(false);
    expect(isDocumentedDaemonRoute("/settings", "QUERY" as DaemonHttpMethod)).toBe(false);
    expect(isDocumentedDaemonRoute("/v1/models", "GET")).toBe(false);
    expect(isDocumentedDaemonRoute("https://daemon.invalid/v2/admin/settings", "GET")).toBe(false);
    expect(isDocumentedDaemonRoute("/v2/https://daemon.invalid", "GET")).toBe(false);
  });

  test("serializes only bounded, allow-listed query values", () => {
    const accounts = findDaemonRouteContract("/providers/openai/accounts");
    expect(accounts).toBeDefined();
    expect(serializeDaemonQuery(accounts!, { limit: 100, cursor: "next page", ignored: "not sent" })).toBe("?limit=100&cursor=next+page");
    expect(isDocumentedDaemonRoute("/providers/openai/accounts?limit=100&cursor=next%20page", "GET")).toBe(true);
    expect(isDocumentedDaemonRoute("/providers/openai/accounts?secret=leaked", "GET")).toBe(false);
    expect(isDocumentedDaemonRoute(`/${"x".repeat(600)}`, "GET")).toBe(false);
    expect(() => serializeDaemonQuery(accounts!, { cursor: "x".repeat(129) })).toThrow("daemon query value is too long");
  });

  test("propagates cancellation and keeps network failures bounded at the state boundary", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(abort).mockRejectedValueOnce(new TypeError("socket details must not escape")));
    await expect(api("/v2/admin/settings", { signal: new AbortController().signal })).rejects.toBe(abort);
    const networkFailure = await daemonGet("/settings").catch((error: unknown) => error);
    expect(daemonFailure(networkFailure)).toEqual({ code: "network_error", message: "daemon request failed", degraded: true });
  });

  test.each([403, 404, 500, 503])("maps HTTP %i to a stable bounded error", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider credentials must not escape", { status })));
    await expect(api("/v2/admin/settings")).rejects.toMatchObject({ status, code: "error", message: `request failed (${status})` });
  });

  test("rejects a successful response with a malformed daemon envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ meta: { request_id: "req-1" } }), { status: 200 })));
    await expect(daemonGet("/settings")).rejects.toEqual(new DaemonContractError("invalid_contract", "daemon response envelope is invalid", 502));
  });
});
