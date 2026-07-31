/**
 * Integration tests for withProxyRequest (src/routes/middleware/proxyRequest.ts) —
 * the shared proxy-auth + tracker + upstream-error-mapping sequence every
 * /v1/* surface route wraps its handler in. Exercises paths not already
 * covered by full end-to-end route tests: the plain-Error rethrow path,
 * the UpstreamError-to-friendly-envelope mapping, and the concurrent-slot
 * release-on-failure lifecycle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetRuntimeSettingsForTests } from "../../src/console/runtime";
import { Elysia } from "elysia";
import { useIsolatedDataDir, loginAndGetCookie, postJson } from "../console/helpers";
import { app } from "../../src/app";
import { withProxyRequest } from "../../src/routes/middleware/proxyRequest";
import { openAIUpstreamError } from "../../src/http/errors";
import { UpstreamError } from "../../src/upstream/providers";
import { queryUsageRequests, type UsageRequestRow } from "../../src/console/db/repos/usage";
import { tryAcquireKeySlot, resetKeyInFlightForTests } from "../../src/console/tracking/key-in-flight";
import { patchRuntimeSettings, ensureSettings } from "../../src/console/db/repos/settings";
import { invalidateRuntimeSettings } from "../../src/console/runtime";

beforeEach(() => {
  useIsolatedDataDir();
  resetKeyInFlightForTests();
});

afterEach(() => {
  // The "concurrent slot lifecycle" test flips proxyAuthMode to "api_key" via
  // patchRuntimeSettings(), which persists into the isolated DATA_DIR this
  // file created. Bun.env.DATA_DIR is process-global, so a later-run test
  // file that never calls useIsolatedDataDir() itself would otherwise inherit
  // that api_key requirement. Restore "open" before this file's global env
  // mutations can reach any other file. patchRuntimeSettings() throws when
  // settings were never initialized (most tests here never touch settings),
  // so this is a best-effort reset, not a required assertion.
  try {
    patchRuntimeSettings({ proxyAuthMode: "open" });
  } catch {
    // Settings were never initialized in this test 
  }
  resetRuntimeSettingsForTests();
});

// The tracker persists usage history fire-and-forget (persist() does not
// await persistAsync()), so tests that assert on queryUsageRequests() must
// flush the microtask queue rather than read immediately after the handler
// resolves. persistAsync only awaits synchronous bun:sqlite calls, so it
// settles within a handful of microtask ticks - no real I/O wait needed,
// which lets this stay a deterministic microtask flush instead of a timer.
async function waitForUsageRow(endpoint: string): Promise<UsageRequestRow | undefined> {
  for (let i = 0; i < 200; i++) {
    const found = queryUsageRequests({ limit: 1_000 }).items.find((r) => r.endpoint === endpoint);
    if (found) return found;
    await Promise.resolve();
  }
  return undefined;
}

function testApp(handler: Parameters<typeof withProxyRequest>[1]) {
  return new Elysia().post("/test-proxy", async ({ request, server, set }) =>
    withProxyRequest(
      {
        endpoint: "/test-proxy",
        surface: "chat",
        model: "test/model",
        stream: false,
        request,
        server,
        set,
        errorMapper: openAIUpstreamError,
      },
      handler,
    ),
  );
}

describe("withProxyRequest — success path", () => {
  test("returns the handler's result unchanged", async () => {
    const testApi = testApp(async (ctx) => {
      ctx.recordRequestBody({ hello: "world" });
      return { ok: true };
    });
    const res = await testApi.handle(postJson("/test-proxy", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("withProxyRequest — UpstreamError mapping", () => {
  test("maps UpstreamError to a friendly envelope instead of rethrowing", async () => {
    const testApi = testApp(async () => {
      throw new UpstreamError("upstream exploded", 503, JSON.stringify({ error: "boom" }));
    });
    const res = await testApi.handle(postJson("/test-proxy", {}));
    expect(res.status).toBe(503);
    const body = await res.json() as { error?: { message?: string } };
    expect(body.error?.message).toBeTruthy();
  });

  test("records the failed request in the usage log with the mapped status", async () => {
    const testApi = testApp(async (ctx) => {
      ctx.recordRequestBody({ model: "test/model" });
      throw new UpstreamError("rate limited upstream", 429, "");
    });
    await testApi.handle(postJson("/test-proxy", {}));
    const failed = await waitForUsageRow("/test-proxy");
    expect(failed?.status).toBe(429);
  });
});

describe("withProxyRequest — internal error path", () => {
  test("rethrows a plain Error instead of swallowing it", async () => {
    const testApi = testApp(async () => {
      throw new Error("something broke internally");
    });
    // Elysia's default error boundary turns an uncaught throw into a 500.
    const res = await testApi.handle(postJson("/test-proxy", {}));
    expect(res.status).toBe(500);
  });

  test("marks the tracker as a 500 internal_error before rethrowing", async () => {
    const testApi = testApp(async (ctx) => {
      ctx.recordRequestBody({ model: "test/model" });
      throw new Error("boom");
    });
    await testApi.handle(postJson("/test-proxy", {}));
    const failed = await waitForUsageRow("/test-proxy");
    expect(failed?.status).toBe(500);
  });
});

describe("withProxyRequest \u2014 concurrent slot lifecycle", () => {
  test("releases the key slot after the handler completes so a later request can acquire it", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/keys", { name: "slot-test", maxConcurrentRequests: 1 }, { cookie }),
    );
    const { key, id } = (await created.json()) as { key: string; id: string };

    const testApi = new Elysia().post("/v1/test-slot", async ({ request, server, set }) =>
      withProxyRequest(
        { endpoint: "/v1/test-slot", surface: "chat", model: undefined, stream: false, request, server, set, errorMapper: openAIUpstreamError },
        async () => ({ ok: true }),
      ),
    );

    const first = await testApi.handle(new Request("http://localhost/v1/test-slot", { method: "POST", headers: { "x-api-key": key } }));
    expect(first.status).toBe(200);

    // Slot was released after the first request finished, so a second
    // request (and a direct acquire) should both succeed.
    expect(tryAcquireKeySlot(id, 1)).toBe(true);
  });
});
