import { afterEach, describe, expect, test } from "bun:test";

import { consoleRequest, fetchSessionUser } from "./api";
import { jsonResponse } from "./test-helpers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installMockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

describe("consoleRequest", () => {
  test("uses same-origin credentials for safe reads", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    installMockFetch(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({ status: "healthy" });
    });

    await consoleRequest<{ status: string }>("/system/health");

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("/console/api/system/health");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(new Headers(calls[0]?.init?.headers).get("Accept")).toBe("application/json");
  });

  test("echoes the double-submit CSRF cookie before dashboard mutations", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    installMockFetch(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({ success: true });
    });
    // Bun has no DOM; stub the cookie jar through a named scope.
    interface CookieJarStub {
      cookie: string;
    }
    const testScope: { document?: CookieJarStub } = globalThis;
    const previousDocument = testScope.document;
    testScope.document = { cookie: "session_token=abc; csrf_token=csrf-cookie" };

    try {
      await consoleRequest<{ success: boolean }>("/api-keys", {
        method: "POST",
        body: JSON.stringify({ label: "test" }),
      });
    } finally {
      testScope.document = previousDocument;
    }

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("/console/api/api-keys");
    expect(new Headers(calls[0]?.init?.headers).get("X-CSRF-Token")).toBe("csrf-cookie");
    expect(new Headers(calls[0]?.init?.headers).get("Content-Type")).toBe("application/json");
  });

  test("allows unauthenticated auth mutations to opt out of CSRF exchange", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    installMockFetch(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({ status: "success" });
    });

    await consoleRequest<{ status: string }>("/auth/login", {
      method: "POST",
      csrf: false,
      body: JSON.stringify({ email: "admin@example.test", password: "secret" }),
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("/console/api/auth/login");
    expect(new Headers(calls[0]?.init?.headers).get("X-CSRF-Token")).toBeNull();
  });
});

describe("fetchSessionUser", () => {
  test("maps an authenticated session to the shared session user shape", async () => {
    installMockFetch(async () =>
      jsonResponse({
        status: "authenticated",
        user_id: "user-1",
        username: "admin",
        email: "admin@example.test",
        display_name: "Admin",
        is_first_boot: false,
        session_expires_at: "2026-09-06T00:00:00.000Z",
        is_platform_admin: true,
      }),
    );

    await expect(fetchSessionUser()).resolves.toEqual({
      id: "user-1",
      username: "admin",
      email: "admin@example.test",
      displayName: "Admin",
      isFirstBoot: false,
      sessionExpiresAt: "2026-09-06T00:00:00.000Z",
      isPlatformAdmin: true,
    });
  });

  test("resolves null when the session is not authenticated", async () => {
    installMockFetch(async () => jsonResponse({ status: "unauthenticated" }));

    await expect(fetchSessionUser()).resolves.toBeNull();
  });
});
