import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, apiDownload, setUnauthorizedHandler } from "../../src/lib/api";

describe("dashboard V2 API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(() => undefined);
  });

  test("redirects unauthorized protected requests through the handler", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(api("/v2/admin/settings")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  test("keeps login failures local without invoking the protected-route handler", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(api("/v2/admin/auth/login", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401, code: "error" });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  test("rejects GET bodies before issuing a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/v2/admin/settings", { method: "GET", body: "{}" })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects V1 and absolute dashboard routes before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/v1/models")).rejects.toEqual(new ApiError(400, "invalid_route", "dashboard routes must use the V2 daemon API"));
    await expect(api("https://daemon.invalid/v2/admin/settings")).rejects.toEqual(new ApiError(400, "invalid_route", "dashboard routes must use the V2 daemon API"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects unsupported methods while preserving contract methods", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/v2/admin/telemetry/usage", { method: "PUT" })).rejects.toMatchObject({ status: 405, code: "method_not_allowed" });
    await api("/v2/admin/telemetry/usage");
    await api("/v2/admin/settings", { method: "PATCH", body: JSON.stringify({ logLevel: "info" }) });
    await api("/v2/admin/settings", { method: "DELETE" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe("GET");
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe("PATCH");
    expect((fetchMock.mock.calls[2] as [string, RequestInit])[1].method).toBe("DELETE");
  });

  test("preserves structured errors and sanitizes non-JSON failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "settings.validation_failed", message: "invalid" } }), { status: 400 })));
    await expect(api("/v2/admin/settings")).rejects.toEqual(new ApiError(400, "settings.validation_failed", "invalid"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider token leaked", { status: 502 })));
    await expect(api("/v2/admin/settings")).rejects.toEqual(new ApiError(502, "error", "request failed (502)"));
  });

  test("downloads V2 blobs and preserves the server filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("backup", {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="config.backup"' },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiDownload("/v2/admin/backups/backup-1/download");

    expect(result.filename).toBe("config.backup");
    expect(await result.blob.text()).toBe("backup");
    expect(fetchMock).toHaveBeenCalledWith("/console/api/v2/admin/backups/backup-1/download", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });
});
