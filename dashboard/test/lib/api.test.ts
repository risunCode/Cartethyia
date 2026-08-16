import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, apiRaw, setUnauthorizedHandler } from "../../src/lib/api";

describe("dashboard console API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(() => undefined);
  });

  test("redirects unauthorized protected requests through the handler", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(api("/console/settings")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  test("keeps login failures local without invoking the protected-route handler", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(api("/console/auth/login", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401, code: "error" });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  test("rejects GET bodies before issuing a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/console/settings", { method: "GET", body: "{}" })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects cross-origin routes before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("https://api.invalid/console/settings")).rejects.toEqual(new ApiError(400, "invalid_route", "dashboard routes must be same-origin console API paths"));
    await expect(api("//api.invalid/console/settings")).rejects.toEqual(new ApiError(400, "invalid_route", "dashboard routes must be same-origin console API paths"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects unsupported methods while preserving contract methods", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/console/telemetry/usage", { method: "PUT" })).rejects.toMatchObject({ status: 405, code: "method_not_allowed" });
    await api("/console/telemetry/usage");
    await api("/console/settings", { method: "PATCH", body: JSON.stringify({ logLevel: "info" }) });
    await api("/console/settings", { method: "DELETE" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe("/console/telemetry/usage");
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe("GET");
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe("PATCH");
    expect((fetchMock.mock.calls[2] as [string, RequestInit])[1].method).toBe("DELETE");
  });

  test("preserves structured errors and sanitizes non-JSON failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "settings.validation_failed", message: "invalid" } }), { status: 400 })));
    await expect(api("/console/settings")).rejects.toEqual(new ApiError(400, "settings.validation_failed", "invalid"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider token leaked", { status: 502 })));
    await expect(api("/console/settings")).rejects.toEqual(new ApiError(502, "error", "request failed (502)"));
  });

  test("apiRaw returns the raw response with headers intact", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("export", {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="requests.export"' },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiRaw("/console/logs?limit=1");

    expect(res.headers.get("content-disposition")).toBe('attachment; filename="requests.export"');
    expect(await res.text()).toBe("export");
    expect(fetchMock).toHaveBeenCalledWith("/console/logs?limit=1", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });
});
