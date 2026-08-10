import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, apiDelete, apiDownload, apiGet, apiPostForm, setUnauthorizedHandler } from "../../src/lib/api";

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
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock).toHaveBeenCalledWith("/console/api/usage/requests?limit=25&cursor=next", expect.objectContaining({
      method: "QUERY",
      body: JSON.stringify({ limit: "25", cursor: "next" }),
      credentials: "same-origin",
    }));
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  test("sends JSON content type without a CSRF bootstrap for destructive mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiDelete("/console-logs");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/console/api/console-logs", expect.objectContaining({ method: "DELETE", body: "{}", credentials: "same-origin" }));
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-cartethyia-csrf")).toBe(false);
  });

  test("preserves multipart bodies without overriding the browser boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.append("file", new Blob(["sqlite"]));

    await apiPostForm("/db-map/import?db=config", form);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  test("downloads blobs and preserves the server filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("sqlite", {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="config.sqlite"' },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiDownload("/db-map/export?db=config");

    expect(result.filename).toBe("config.sqlite");
    expect(await result.blob.text()).toBe("sqlite");
    expect(fetchMock).toHaveBeenCalledWith("/console/api/db-map/export?db=config", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });
});
