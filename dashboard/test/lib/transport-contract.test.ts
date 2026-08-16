import { afterEach, describe, expect, test, vi } from "vitest";
import { api, type ConsoleHttpMethod } from "../../src/lib/api";
import { consoleFailure, consoleGet, ConsoleContractError } from "../../src/lib/console-api";
import {
  CONSOLE_ROUTE_MATRIX,
  findConsoleRouteContract,
  isDocumentedConsoleRoute,
  serializeConsoleQuery,
} from "../../src/lib/console-routes";

describe("dashboard transport route contract", () => {
  afterEach(() => vi.restoreAllMocks());

  test("checks every retained route against standard methods only", () => {
    expect(CONSOLE_ROUTE_MATRIX.length).toBeGreaterThan(0);
    for (const contract of CONSOLE_ROUTE_MATRIX) {
      expect(contract.route.startsWith("/v2/")).toBe(false);
      expect(contract.methods.every((method): method is ConsoleHttpMethod => ["GET", "POST", "PATCH", "DELETE"].includes(method))).toBe(true);
      expect(contract.methods).not.toContain("QUERY");
    }
    expect(isDocumentedConsoleRoute("/settings", "GET")).toBe(true);
    expect(isDocumentedConsoleRoute("/settings", "PATCH")).toBe(true);
    expect(isDocumentedConsoleRoute("/settings", "POST")).toBe(true);
    expect(isDocumentedConsoleRoute("/settings", "DELETE")).toBe(false);
    expect(isDocumentedConsoleRoute("/providers/openai/accounts/batch-delete", "POST")).toBe(true);
    expect(isDocumentedConsoleRoute("/providers/openai/accounts/batch-delete", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute("/settings", "QUERY" as ConsoleHttpMethod)).toBe(false);
    expect(isDocumentedConsoleRoute("/v1/models", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute("https://api.invalid/v2/admin/settings", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute("/v2/https://api.invalid", "GET")).toBe(false);
  });

  test("serializes only bounded, allow-listed query values", () => {
    const accounts = findConsoleRouteContract("/providers/openai/accounts");
    expect(accounts).toBeDefined();
    expect(serializeConsoleQuery(accounts!, { limit: 100, cursor: "next page", ignored: "not sent" })).toBe("?limit=100&cursor=next+page");
    expect(isDocumentedConsoleRoute("/providers/openai/accounts?limit=100&cursor=next%20page", "GET")).toBe(true);
    expect(isDocumentedConsoleRoute("/providers/openai/accounts?secret=leaked", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute(`/${"x".repeat(600)}`, "GET")).toBe(false);
    expect(() => serializeConsoleQuery(accounts!, { cursor: "x".repeat(129) })).toThrow("API query value is too long");
  });

  test("propagates cancellation and keeps network failures bounded at the state boundary", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(abort).mockRejectedValueOnce(new TypeError("socket details must not escape")));
    await expect(api("/v2/admin/settings", { signal: new AbortController().signal })).rejects.toBe(abort);
    const networkFailure = await consoleGet("/settings").catch((error: unknown) => error);
    expect(consoleFailure(networkFailure)).toEqual({ code: "network_error", message: "API request failed", degraded: true });
  });

  test.each([403, 404, 500, 503])("maps HTTP %i to a stable bounded error", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider credentials must not escape", { status })));
    await expect(api("/v2/admin/settings")).rejects.toMatchObject({ status, code: "error", message: `request failed (${status})` });
  });

  test("rejects a successful response with a malformed API envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ meta: { request_id: "req-1" } }), { status: 200 })));
    await expect(consoleGet("/settings")).rejects.toEqual(new ConsoleContractError("invalid_contract", "API response envelope is invalid", 502));
  });
});
