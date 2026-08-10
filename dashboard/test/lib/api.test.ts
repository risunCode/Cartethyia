import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, apiDelete, apiGet, setUnauthorizedHandler } from "../../src/lib/api";

describe("dashboard API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(() => undefined);
  });

  test("redirects unauthorized protected requests through the handler", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(api("/overview")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  test("preserves structured API errors and handles non-JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "bad_request", message: "invalid" } }), { status: 400 })));
    await expect(api("/settings")).rejects.toEqual(new ApiError(400, "bad_request", "invalid"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream unavailable", { status: 502 })));
    await expect(api("/settings")).rejects.toEqual(new ApiError(502, "error", "request failed (502)"));
  });

  test("sends safe reads as JSON QUERY requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/usage/requests?limit=25&cursor=next");
    expect(fetchMock).toHaveBeenCalledWith("/console/api/usage/requests?limit=25&cursor=next", expect.objectContaining({
      method: "QUERY",
      body: JSON.stringify({ limit: "25", cursor: "next" }),
      headers: { "content-type": "application/json" },
    }));
  });

  test("sends JSON content type for destructive mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiDelete("/console-logs");
    expect(fetchMock).toHaveBeenCalledWith("/console/api/console-logs", expect.objectContaining({ method: "DELETE", body: "{}", headers: { "content-type": "application/json" } }));
  });
});
