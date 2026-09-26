import { describe, expect, test } from "bun:test";
import type { LoginResponse, SessionStatusResponse } from "../../src/console/auth/session";
import { defaultSessionCookiePolicy } from "../../src/console/auth/service";
import type { HealthStatus, SessionResponse } from "../../dashboard/src/lib/contracts";
import { consoleRequest } from "../../dashboard/src/lib/api";

/**
 * Dashboard backend-boundary contracts expressible without the JSX toolchain:
 * the session-cookie policy, the session/mutation status unions, and the
 * same-origin API boundary. Render-level dashboard contracts live in the
 * dashboard workspace (`dashboard/test/route-modules.test.ts`), which owns JSX.
 */

describe("dashboard auth and status contracts", () => {
  test("preserves the 48-hour environment-aware session-cookie policy", () => {
    expect(defaultSessionCookiePolicy).toEqual({
      maxAge: 48 * 60 * 60,
      httpOnly: true,
      sameSite: "Lax",
      secure:
        process.env.NODE_ENV === "production" ||
        process.env.CARTETHYIA_PUBLIC_ORIGIN?.startsWith("https://") === true,
    });
  });

  test("accepts only the documented session and mutation status variants", () => {
    const loginSuccess: LoginResponse = {
      status: "success",
      user_id: "user-1",
      requires_setup: false,
    };
    const loginFailure: LoginResponse = { status: "failed", message: "Invalid credentials" };
    const unauthenticated: SessionStatusResponse = { status: "unauthenticated" };
    const authenticated: SessionStatusResponse = {
      status: "authenticated",
      user_id: "user-1",
      username: "admin",
      email: "admin@example.test",
      display_name: null,
      is_first_boot: false,
      session_expires_at: "2026-08-31T00:00:00.000Z",
      is_platform_admin: false,
    };
    const statuses: readonly HealthStatus[] = ["active", "cooldown", "disabled"];

    expect(loginSuccess.status).toBe("success");
    expect(loginFailure.status).toBe("failed");
    expect(unauthenticated.status).toBe("unauthenticated");
    expect(authenticated.status).toBe("authenticated");
    expect(statuses).toHaveLength(3);
  });

  test("uses a same-origin API boundary and preserves typed error status", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ status: "unauthenticated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const result = await consoleRequest<SessionResponse>("/auth/session");
      expect(result.status).toBe("unauthenticated");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("/console/api/auth/session");
      expect(calls[0]?.init?.credentials).toBe("same-origin");
      expect(new Headers(calls[0]?.init?.headers).get("Accept")).toBe("application/json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns the backend HTTP status and safe fallback message for failed API calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await expect(consoleRequest<unknown>("/providers")).rejects.toEqual({
        status: 403,
        message: "forbidden",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
