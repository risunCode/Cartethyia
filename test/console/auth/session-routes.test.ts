import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { consoleLockouts, consoleSessions, consoleUsers, tenants } from "../../../src/persistence/schema";
import { createConsoleAuthRoutes } from "../../../src/console/auth/session";
import {
  ConsoleCredentialService,
  ConsoleLockoutService,
  ConsoleSessionService,
  defaultSessionCookiePolicy,
  type FirstBootSetupService,
} from "../../../src/console/auth/service";
import { dbDescribe } from "../../helpers/db-gate";

/**
 * The console auth HTTP surface: login, session status, logout, and first boot.
 *
 * These handlers are the only way a browser reaches the session machinery, so
 * what they decide is a security contract: an unidentifiable client must be
 * refused rather than trusted, a failed login must be counted by the lockout
 * service (and a repeated one blocked), a session row deleted when its user is
 * gone, and `/first-boot` must answer without a session because it is what the
 * setup screen asks before anyone can log in.
 *
 * Runs against the shared isolated database, so every row this suite creates is
 * removed by id in `afterAll`.
 */
dbDescribe("console auth routes", () => {
  let db: CartethyiaDatabase;
  const credentialService = new ConsoleCredentialService();
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];
  const PASSWORD = "correct-horse-battery-staple";

  const sessionService = {
    // A stand-in for the setup service: `/first-boot` and `/setup` are about
    // the *route's* decisions (status codes, body validation, the ordering of
    // the requiresSetup check), and those are what is asserted here.
    requiresSetup: true,
    completeSetupCalls: [] as Array<{ password: string; username?: string; displayName?: string }>,
    completeSetup: async (): Promise<void> => undefined,
    throwOnComplete: null as Error | null,
  };

  let lockoutService: ConsoleLockoutService;
  let sessions: ConsoleSessionService;

  /**
   * The lockout buckets this suite created, as `<identifier>:<ip>`.
   *
   * `console_lockouts` carries no tenant column, so it cannot be cleaned by
   * tenant; the exact keys are recorded instead. Left behind, a bucket blocks
   * the next run of the test that expects a 401.
   */
  const lockoutKeys: string[] = [];

  beforeAll(() => {
    db = getDb();
    lockoutService = new ConsoleLockoutService(db);
    sessions = new ConsoleSessionService(db, { ...defaultSessionCookiePolicy, secure: false });
  });

  afterAll(async () => {
    // `console_lockouts` is keyed by `<identifier>:<ip>` and has no tenant
    // column, so it is cleaned by the identifiers this suite used. A leftover
    // row would block the next run: the bucket is process-external state.
    await db.delete(consoleLockouts).where(inArray(consoleLockouts.ip, lockoutKeys.splice(0)));
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(consoleSessions).where(eq(consoleSessions.userId, userId));
      await db.delete(consoleUsers).where(eq(consoleUsers.id, userId));
    }
    for (const tenantId of createdTenantIds.splice(0)) {
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });

  function setupService(): FirstBootSetupService {
    return {
      async requiresSetup() {
        return sessionService.requiresSetup;
      },
      async completeSetup(password: string, username?: string, displayName?: string) {
        if (sessionService.throwOnComplete) throw sessionService.throwOnComplete;
        sessionService.completeSetupCalls.push({ password, ...(username === undefined ? {} : { username }), ...(displayName === undefined ? {} : { displayName }) });
      },
    } as unknown as FirstBootSetupService;
  }

  /**
   * An app whose peer address is known, so the identity gate passes.
   *
   * The peer is passed as a sentinel rather than a defaulted parameter:
   * `app(NO_PEER)` would trigger the default and silently test the opposite
   * case from the one intended.
   */
  const NO_PEER = Symbol("no-peer");
  function app(peerAddress: string | typeof NO_PEER = "127.0.0.1") {
    return createConsoleAuthRoutes(
      db,
      credentialService,
      sessions,
      lockoutService,
      setupService(),
      { ...defaultSessionCookiePolicy, secure: false },
      { mode: "disabled" },
      () => (peerAddress === NO_PEER ? undefined : peerAddress),
    );
  }

  async function createUser(
    options: { username?: string; isActive?: boolean; isFirstBoot?: boolean } = {},
  ): Promise<{ userId: string; username: string }> {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    await db.insert(tenants).values({ id: tenantId, name: `auth-routes-${tenantId}`, status: "active" });
    const userId = randomUUID();
    createdUserIds.push(userId);
    const username = options.username ?? `routes-${userId.slice(0, 8)}`;
    // Every login attempt against this identifier lands in the bucket
    // `<username>:<ip>`, including a *successful* one only after a failure —
    // record it here so cleanup covers all of them without each test having to
    // remember.
    lockoutKeys.push(`${username}:127.0.0.1`);
    await db.insert(consoleUsers).values({
      id: userId,
      tenantId,
      username,
      passwordHash: await credentialService.hashPassword(PASSWORD),
      isActive: options.isActive ?? true,
      isFirstBoot: options.isFirstBoot ?? false,
      isPlatformAdmin: false,
    });
    return { userId, username };
  }

  function jsonRequest(
    path: string,
    body: Record<string, unknown>,
    cookie?: string,
  ): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = `session_token=${cookie}`;
    return new Request(`http://localhost/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  test("login refuses a request whose client identity cannot be resolved", async () => {
    const response = await app(NO_PEER).handle(
      jsonRequest("/login", { username: "whoever", password: PASSWORD }),
    );
    // Failing closed matters: an unresolvable peer means the lockout key cannot
    // be formed, and a shared bucket would let one attacker lock out everyone.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "failed" });
  });

  test("login rejects a missing password field", async () => {
    const response = await app().handle(
      jsonRequest("/login", { username: "someone" }),
    );
    expect(response.status).toBe(422);
  });

  test("login with unknown credentials is a 401 and does not leak which part failed", async () => {
    // A per-test identifier: the lockout bucket is `<identifier>:<ip>` and is
    // process-external, so a fixed name would inherit failures from an earlier
    // run and answer 429 instead of the 401 under test.
    const unknownUser = `no-such-user-${randomUUID().slice(0, 8)}`;
    lockoutKeys.push(`${unknownUser}:127.0.0.1`);
    const response = await app().handle(
      jsonRequest("/login", {
        username: unknownUser,
        password: "whatever-1",
      }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { status: string; message: string };
    expect(body.status).toBe("failed");
    expect(body.message).toBe("Invalid credentials");
  });

  test("login with a valid password issues a session cookie", async () => {
    const { username } = await createUser();
    const response = await app().handle(
      jsonRequest("/login", { username, password: PASSWORD }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; user_id: string };
    expect(body.status).toBe("success");
    expect(body.user_id).toBeDefined();
    // The session cookie is set httpOnly; the CSRF cookie accompanies it.
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith("session_token="))).toBe(true);
  });

  test("login accepts an email in place of a username", async () => {
    const { username } = await createUser();
    const response = await app().handle(
      jsonRequest("/login", { email: username, password: PASSWORD }),
    );
    expect(response.status).toBe(200);
  });

  test("login reports a first-boot user so the console can force the change", async () => {
    const { username } = await createUser({ isFirstBoot: true });
    const response = await app().handle(
      jsonRequest("/login", { username, password: PASSWORD }),
    );
    const body = (await response.json()) as { requires_setup: boolean };
    expect(body.requires_setup).toBe(true);
  });

  test("an inactive user cannot log in", async () => {
    const { username } = await createUser({ isActive: false });
    const response = await app().handle(
      jsonRequest("/login", { username, password: PASSWORD }),
    );
    expect(response.status).toBe(401);
  });

  test("repeated failures eventually block the login with a retry-after", async () => {
    const { username } = await createUser();
    lockoutKeys.push(`${username}:127.0.0.1`);
    let blocked: Response | undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await app().handle(
        jsonRequest("/login", { username, password: "wrong-password" }),
      );
      if (response.status === 429) {
        blocked = response;
        break;
      }
    }
    expect(blocked).toBeDefined();
    expect(blocked!.headers.get("retry-after")).toBeTruthy();
    // A blocked login is refused even with the *correct* password.
    const afterBlock = await app().handle(
      jsonRequest("/login", { username, password: PASSWORD }),
    );
    expect(afterBlock.status).toBe(429);
  });

  test("GET /session is unauthenticated without a cookie", async () => {
    const response = await app().handle(new Request("http://localhost/auth/session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unauthenticated" });
  });

  test("GET /session is unauthenticated for an unknown token", async () => {
    const response = await app().handle(
      new Request("http://localhost/auth/session", {
        headers: { Cookie: "session_token=not-a-real-token" },
      }),
    );
    expect(await response.json()).toEqual({ status: "unauthenticated" });
  });

  test("GET /session reports the signed-in user", async () => {
    const { userId, username } = await createUser();
    const session = await sessions.createSession(userId, "127.0.0.1", "test-agent");
    const response = await app().handle(
      new Request("http://localhost/auth/session", {
        headers: { Cookie: `session_token=${session.sessionToken}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("authenticated");
    expect(body["user_id"]).toBe(userId);
    expect(body["username"]).toBe(username);
  });

  test("GET /session invalidates a session whose user was deactivated", async () => {
    const { userId } = await createUser();
    const session = await sessions.createSession(userId, "127.0.0.1", "test-agent");
    await db.update(consoleUsers).set({ isActive: false }).where(eq(consoleUsers.id, userId));
    const response = await app().handle(
      new Request("http://localhost/auth/session", {
        headers: { Cookie: `session_token=${session.sessionToken}` },
      }),
    );
    expect(await response.json()).toEqual({ status: "unauthenticated" });
    // The dead session row is removed, not merely ignored.
    expect(await sessions.validateSession(session.sessionToken)).toBeNull();
  });

  test("POST /logout succeeds with and without a session", async () => {
    const { userId } = await createUser();
    const session = await sessions.createSession(userId, "127.0.0.1", "test-agent");
    const withSession = await app().handle(
      new Request("http://localhost/auth/logout", {
        method: "POST",
        headers: { Cookie: `session_token=${session.sessionToken}` },
      }),
    );
    expect(withSession.status).toBe(200);
    expect(await sessions.validateSession(session.sessionToken)).toBeNull();

    const withoutSession = await app().handle(
      new Request("http://localhost/auth/logout", { method: "POST" }),
    );
    expect(withoutSession.status).toBe(200);
  });

  test("GET /first-boot answers without a session", async () => {
    // The setup screen asks this before anyone can authenticate.
    const response = await app().handle(new Request("http://localhost/auth/first-boot"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requires_setup: true });
  });

  test("POST /setup rejects an empty password", async () => {
    const response = await app().handle(jsonRequest("/setup", { password: "" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: "Password is required" });
  });

  test("POST /setup refuses when setup already completed", async () => {
    sessionService.requiresSetup = false;
    try {
      const response = await app().handle(jsonRequest("/setup", { password: PASSWORD }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ message: "Setup already completed" });
    } finally {
      sessionService.requiresSetup = true;
    }
  });

  test("POST /setup completes when the service accepts it", async () => {
    sessionService.completeSetupCalls.length = 0;
    const response = await app().handle(
      jsonRequest("/setup", { password: PASSWORD, username: "  bootadmin  " }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "success" });
    // The username is trimmed before it reaches the service.
    expect(sessionService.completeSetupCalls[0]?.username).toBe("bootadmin");
  });

  test("POST /setup maps a raced completion to a 400, not a 500", async () => {
    sessionService.throwOnComplete = new Error("Setup already completed");
    try {
      const response = await app().handle(jsonRequest("/setup", { password: PASSWORD }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ message: "Setup already completed" });
    } finally {
      sessionService.throwOnComplete = null;
    }
  });
});
