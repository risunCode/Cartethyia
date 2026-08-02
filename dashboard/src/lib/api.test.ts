import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { ApiError, setUnauthorizedHandler, api, apiDelete } from "./api";

describe("ApiError", () => {
  test("message, status, and code are set from constructor", () => {
    const err = new ApiError(404, "not_found", "Resource not found");
    expect(err.message).toBe("Resource not found");
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  test("is an instance of Error", () => {
    expect(new ApiError(500, "internal", "oops")).toBeInstanceOf(Error);
  });

  test("is an instance of ApiError", () => {
    expect(new ApiError(400, "bad_request", "bad")).toBeInstanceOf(ApiError);
  });

  test("can be caught as Error in try/catch", () => {
    const err = new ApiError(401, "unauthorized", "session expired");
    expect(() => { throw err; }).toThrow("session expired");
  });
});

describe("api — fetch wrapper", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // vi.fn() doesn't satisfy `typeof fetch` (missing preconnect etc.) — cast through unknown to bypass the structural check
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeResponse(status: number, body: unknown): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }

  test("returns parsed JSON on a 200 response", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(200, { ok: true }));
    const result = await api("/test");
    expect(result).toEqual({ ok: true });
  });

  test("throws ApiError with error code from server on a non-ok response", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      makeResponse(400, { error: { code: "invalid_request", message: "bad input" } }),
    );
    await expect(api("/test")).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "bad input",
    });
  });

  test("throws ApiError with fallback code 'error' when server omits error body", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(500, ""));
    await expect(api("/test")).rejects.toMatchObject({
      status: 500,
      code: "error",
    });
  });

  test("calls onUnauthorized handler and throws ApiError on 401", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(401, null));
    await expect(api("/test")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(handler).toHaveBeenCalledOnce();
    // Reset handler
    setUnauthorizedHandler(null as unknown as () => void);
  });

  test("preserves the server wrong-password message for login 401 responses", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.mocked(global.fetch).mockResolvedValueOnce(
      makeResponse(401, { error: { code: "unauthorized", message: "wrong password" } }),
    );

    await expect(api("/login", { method: "POST", body: "{}" })).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "wrong password",
    });
    expect(handler).not.toHaveBeenCalled();
    setUnauthorizedHandler(null as unknown as () => void);
  });

  test("includes content-type header when body is provided", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(200, {}));
    await api("/test", { method: "POST", body: JSON.stringify({ x: 1 }) });
    const call = vi.mocked(global.fetch).mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)?.["content-type"]).toBe("application/json");
  });

  test("omits content-type header when no body", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(200, {}));
    await api("/test");
    const call = vi.mocked(global.fetch).mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)?.["content-type"]).toBeUndefined();
  });

  // Regression: apiDelete previously sent no body at all, unlike
  // apiPost/apiPatch (which always default to "{}"), so `api()`'s
  // conditional content-type logic above never fired for it - every DELETE
  // request from the dashboard was missing `content-type: application/json`
  // and got rejected by the console's CSRF guard
  // (src/console/auth/guard.ts) with 403 "mutating console requests
  // require Content-Type: application/json".
  test("apiDelete sends a body so content-type: application/json is set", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(200, { ok: true }));
    await apiDelete("/keys/abc");
    const call = vi.mocked(global.fetch).mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)?.["content-type"]).toBe("application/json");
    expect(init.body).toBeDefined();
  });

  test("uses same-origin credentials", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(200, {}));
    await api("/test");
    const call = vi.mocked(global.fetch).mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
  });

  test("prefixes /console/api to the path", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(200, {}));
    await api("/keys");
    const call = vi.mocked(global.fetch).mock.calls[0]!;
    expect(call[0]).toBe("/console/api/keys");
  });

  test("returns null when response body is empty on a 200", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(200, ""));
    const result = await api("/test");
    expect(result).toBeNull();
  });
});
