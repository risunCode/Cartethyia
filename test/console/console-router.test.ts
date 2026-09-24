/**
 * Composition regression guard for the console login identity gate.
 *
 * The login route keys its lockout bucket on `username:clientIp` and fails
 * closed with a 503 when no peer address is available. That gate sits *before*
 * every database read, which is what makes it testable without a live DB — but
 * it also means a missing `resolvePeerAddress` wiring silently turned every
 * login into "Console client identity is unavailable" while the auth tests
 * (which inject a resolver directly into `createConsoleAuthRoutes`) stayed
 * green. These tests assert the forwarding at the composition boundary, where
 * the bug actually lived.
 */
import { describe, expect, test } from "bun:test";
import { createConsoleRouter, type ConsoleApiCompositionDeps } from "../../src/console/console-router";

/** A db whose every property access throws, proving no query ran. */
function throwingDb(): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`unexpected database access: ${String(property)}`);
      },
    },
  ) as never;
}

function compositionDeps(
  overrides: Partial<ConsoleApiCompositionDeps> = {},
): ConsoleApiCompositionDeps {
  return {
    db: throwingDb(),
    accessResolver: () => undefined,
    routeSnapshotService: {} as never,
    poolSelector: {} as never,
    telemetryBuffer: {} as never,
    providerRegistry: {} as never,
    bundledModelCatalog: {
      modelsByProvider: new Map(),
    },
    networkBindingFactory: {} as never,
    redis: {} as never,
    oauthRefreshService: {} as never,
    admissionService: {} as never,
    ...overrides,
  };
}

async function login(router: ReturnType<typeof createConsoleRouter>): Promise<Response> {
  return router.handle(
    new Request("http://console.test/console/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "irrelevant" }),
    }),
  );
}

describe("console router composition", () => {
  test("fails closed with 503 when no peer-address resolver is wired", async () => {
    const response = await login(createConsoleRouter(compositionDeps()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "failed",
      message: "Console client identity is unavailable",
    });
  });

  test("forwards resolvePeerAddress so the login identity gate is satisfied", async () => {
    const response = await login(
      createConsoleRouter(
        compositionDeps({
          resolvePeerAddress: () => "203.0.113.7",
          trustedProxyBoundary: { mode: "disabled" },
        }),
      ),
    );
    // Past the identity gate the handler reaches the (throwing) stub db, so the
    // only outcome that proves the resolver was consulted is "not the 503".
    expect(response.status).not.toBe(503);
    const body = (await response.json()) as { message?: string };
    expect(body.message).not.toBe("Console client identity is unavailable");
  });

  test("treats a null peer address as unavailable rather than coercing it", async () => {
    const response = await login(
      createConsoleRouter(compositionDeps({ resolvePeerAddress: () => null })),
    );
    expect(response.status).toBe(503);
  });
});
