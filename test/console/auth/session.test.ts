import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { tenants, consoleSessions, consoleUsers, adminAuditLog } from "../../../src/persistence/schema";
import { createConsoleAuthRoutes, securePolicyForRequest } from "../../../src/console/auth/session";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  clearCsrfCookie,
  isCsrfValid,
  newCsrfToken,
  parseCookieValue,
  setCsrfCookie,
} from "../../../src/security/csrf";
import { ConsoleCredentialService } from "../../../src/console/auth/service";
import { ConsoleSessionService, defaultSessionCookiePolicy } from "../../../src/console/auth/service";
import { ConsoleLockoutService } from "../../../src/console/auth/service";
import type { FirstBootSetupService } from "../../../src/console/auth/service";
let db: CartethyiaDatabase;
let credentialService: ConsoleCredentialService;
let sessionService: ConsoleSessionService;
let lockoutService: ConsoleLockoutService;
const setupService = {} as FirstBootSetupService;

function app() {
  return createConsoleAuthRoutes(
    db,
    credentialService,
    sessionService,
    lockoutService,
    setupService,
    undefined,
    undefined,
    () => "127.0.0.1",
  );
}

dbDescribe("POST /auth/change-password", () => {
  beforeAll(() => {
    db = getDb();
    credentialService = new ConsoleCredentialService();
    sessionService = new ConsoleSessionService(db, {
      ...defaultSessionCookiePolicy,
      secure: false,
    });
    lockoutService = new ConsoleLockoutService(db);
  });

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createTestUser(password: string): Promise<{
  userId: string;
  sessionToken: string;
}> {
  const tenantId = randomUUID();
  await db
    .insert(tenants)
    .values({ id: tenantId, name: "auth-change-password-test", status: "active" });
  createdTenantIds.push(tenantId);

  const userId = randomUUID();
  createdUserIds.push(userId);
  const passwordHash = await credentialService.hashPassword(password);
  await db.insert(consoleUsers).values({
    id: userId,
    tenantId,
    username: `cp-test-${userId.slice(0, 8)}`,
    passwordHash,
    isActive: true,
    isFirstBoot: false,
  });

  const session = await sessionService.createSession(
    userId,
    "127.0.0.1",
    "auth-change-password-test",
  );
  return { userId, sessionToken: session.sessionToken };
}
afterAll(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await db.delete(consoleSessions).where(eq(consoleSessions.userId, userId));
    await db.delete(adminAuditLog).where(eq(adminAuditLog.actor, userId));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, userId));
  }
  for (const tenantId of createdTenantIds.splice(0)) {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});

function changePasswordRequest(
  sessionToken: string | undefined,
  body: Record<string, unknown>,
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionToken) headers.Cookie = `session_token=${sessionToken}`;
  return new Request("http://localhost/auth/change-password", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}


  test("401s without a session cookie", async () => {
    const response = await app().handle(
      changePasswordRequest(undefined, { currentPassword: "x", newPassword: "newpassword1" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: "failed" });
  });

  test("401s with an invalid session token", async () => {
    const response = await app().handle(
      changePasswordRequest("not-a-real-token", {
        currentPassword: "x",
        newPassword: "newpassword1",
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      status: "failed",
      message: "Session expired",
    });
  });

  test("400s when the new password is shorter than 8 characters", async () => {
    const { sessionToken } = await createTestUser("original-password-1");
    const response = await app().handle(
      changePasswordRequest(sessionToken, {
        currentPassword: "original-password-1",
        newPassword: "short",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "failed",
      message: "New password must be at least 8 characters",
    });
  });

  test("401s when the current password is incorrect", async () => {
    const { sessionToken } = await createTestUser("original-password-2");
    const response = await app().handle(
      changePasswordRequest(sessionToken, {
        currentPassword: "totally-wrong",
        newPassword: "newpassword123",
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      status: "failed",
      message: "Current password is incorrect",
    });
  });

  test("200s on a correct current password and actually persists the new hash", async () => {
    const { userId, sessionToken } = await createTestUser("original-password-3");
    const response = await app().handle(
      changePasswordRequest(sessionToken, {
        currentPassword: "original-password-3",
        newPassword: "brand-new-password-4",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "success" });

    const rows = await db.select().from(consoleUsers).where(eq(consoleUsers.id, userId)).limit(1);
    const updatedHash = rows[0]?.passwordHash;
    expect(typeof updatedHash).toBe("string");
    expect(await credentialService.verifyPassword("brand-new-password-4", updatedHash!)).toBe(true);
    expect(await credentialService.verifyPassword("original-password-3", updatedHash!)).toBe(false);
  });

  test("invalidates sibling sessions, keeps the current one, and audits the rotation", async () => {
    const { userId, sessionToken } = await createTestUser("original-password-5");
    const sibling = await sessionService.createSession(userId, "127.0.0.1", "sibling-device");
    const response = await app().handle(
      changePasswordRequest(sessionToken, {
        currentPassword: "original-password-5",
        newPassword: "brand-new-password-6",
      }),
    );
    expect(response.status).toBe(200);
    expect(await sessionService.validateSession(sessionToken)).not.toBeNull();
    expect(await sessionService.validateSession(sibling.sessionToken)).toBeNull();
    const audit = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.actor, userId));
    expect(audit.some((row) => row.action === "console.password_changed")).toBe(true);
  });
});

describe("securePolicyForRequest", () => {
  const insecure = { ...defaultSessionCookiePolicy, secure: false };
  const trusted = { mode: "trusted", allowlist: ["10.0.0.0/8"] } as const;

  function get(url: string, headers: Record<string, string> = {}): Request {
    return new Request(url, { headers });
  }

  test("keeps an already-secure policy untouched", () => {
    const out = securePolicyForRequest(
      get("http://localhost/console", { "x-forwarded-proto": "https" }),
      defaultSessionCookiePolicy,
      { mode: "disabled" },
      "10.1.2.3",
    );
    expect(out).toBe(defaultSessionCookiePolicy);
  });

  test("upgrades on direct https", () => {
    const out = securePolicyForRequest(get("https://console.example.com/console"), insecure, {
      mode: "disabled",
    }, undefined);
    expect(out.secure).toBe(true);
  });

  test("upgrades behind a trusted TLS-terminating proxy", () => {
    const out = securePolicyForRequest(
      get("http://localhost/console", { "x-forwarded-proto": "https" }),
      insecure,
      trusted,
      "10.1.2.3",
    );
    expect(out.secure).toBe(true);
  });

  test("ignores forwarded proto from untrusted peers and plain http", () => {
    const spoofed = securePolicyForRequest(
      get("http://localhost/console", { "x-forwarded-proto": "https" }),
      insecure,
      trusted,
      "203.0.113.9",
    );
    expect(spoofed.secure).toBe(false);
    const plain = securePolicyForRequest(get("http://localhost/console"), insecure, trusted, "10.1.2.3");
    expect(plain.secure).toBe(false);
  });
});

function requestWithCookies(cookieHeader: string, csrfHeader?: string): Request {
  const headers: Record<string, string> = { cookie: cookieHeader };
  if (csrfHeader !== undefined) headers[CSRF_HEADER_NAME] = csrfHeader;
  return new Request("https://console.test/console/api/api-keys", { method: "POST", headers });
}

function jarWith(capture: { options?: Record<string, unknown> }, value: unknown) {
  return {
    [CSRF_COOKIE_NAME]: {
      value,
      set: (options: Record<string, unknown>) => {
        capture.options = options;
      },
    },
  };
}

// Merged from csrf.test.ts (stateless double-submit CSRF coverage).
describe("stateless double-submit CSRF", () => {
  test("issues unique high-entropy tokens", () => {
    const a = newCsrfToken();
    const b = newCsrfToken();
    expect(a.length).toBeGreaterThan(32);
    expect(a).not.toBe(b);
  });

  test("accepts a matching header/cookie pair with no database", () => {
    const token = newCsrfToken();
    const request = requestWithCookies(`${CSRF_COOKIE_NAME}=${token}`, token);
    expect(parseCookieValue(request, CSRF_COOKIE_NAME)).toBe(token);
    expect(isCsrfValid(request)).toBe(true);
  });

  test("rejects mismatched, missing, and empty pairs", () => {
    const token = newCsrfToken();
    expect(isCsrfValid(requestWithCookies(`${CSRF_COOKIE_NAME}=${token}`, "forged"))).toBe(false);
    expect(isCsrfValid(requestWithCookies(`${CSRF_COOKIE_NAME}=${token}`))).toBe(false);
    expect(isCsrfValid(requestWithCookies("", token))).toBe(false);
    expect(isCsrfValid(requestWithCookies(`${CSRF_COOKIE_NAME}=${token}`, ""))).toBe(false);
  });

  test("sets a readable cookie bound to the session policy", () => {
    const capture: { options?: Record<string, unknown> } = {};
    setCsrfCookie(jarWith(capture, "ignored"), defaultSessionCookiePolicy, "tok");
    expect(capture.options?.["value"]).toBe("tok");
    // Readable by dashboard JS on purpose — session auth stays HttpOnly.
    expect(capture.options?.["httpOnly"]).toBe(false);
    expect(capture.options?.["path"]).toBe("/");
    expect(capture.options?.["maxAge"]).toBe(defaultSessionCookiePolicy.maxAge);
  });

  test("clears the cookie on logout and session expiry", () => {
    const capture: { options?: Record<string, unknown> } = {};
    clearCsrfCookie(jarWith(capture, "ignored"), defaultSessionCookiePolicy);
    expect(capture.options?.["value"]).toBe("");
    expect(capture.options?.["maxAge"]).toBe(0);
  });
});

// Merged from service.unit.test.ts (credential/session service unit coverage).
describe("ConsoleCredentialService", () => {
  let service: ConsoleCredentialService;

  beforeEach(() => {
    service = new ConsoleCredentialService();
  });

  it("should hash passwords", async () => {
    const password = "test-password";
    const hash = await service.hashPassword(password);

    expect(hash).toBeTruthy();
    expect(hash).not.toBe(password);
  });

  it("should verify correct password", async () => {
    const password = "test-password";
    const hash = await service.hashPassword(password);
    const valid = await service.verifyPassword(password, hash);

    expect(valid).toBe(true);
  });

  it("should reject incorrect password", async () => {
    const password = "test-password";
    const hash = await service.hashPassword(password);
    const valid = await service.verifyPassword("wrong-password", hash);

    expect(valid).toBe(false);
  });

  it("should return false on invalid hash", async () => {
    const valid = await service.verifyPassword("password", "invalid_hash");
    expect(valid).toBe(false);
  });
});

describe("ConsoleSessionService", () => {
  let service: ConsoleSessionService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ id: "session-123" }]),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
      delete: () => ({
        where: () => Promise.resolve(),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
    };

    service = new ConsoleSessionService(mockDb, defaultSessionCookiePolicy);
  });

  it("should create a session", async () => {
    const session = await service.createSession("user-123");

    expect(session).toBeDefined();
    expect(session.sessionToken).toBeTruthy();
    expect(session.expiresAt).toBeInstanceOf(Date);
  });

  it("uses a 48-hour environment-aware default cookie policy", () => {
    expect(defaultSessionCookiePolicy.maxAge).toBe(48 * 60 * 60);
    expect(defaultSessionCookiePolicy.httpOnly).toBe(true);
    expect(defaultSessionCookiePolicy.secure).toBe(
      process.env.NODE_ENV === "production" ||
        process.env.CARTETHYIA_PUBLIC_ORIGIN?.startsWith("https://") === true,
    );
    expect(defaultSessionCookiePolicy.sameSite).toBe("Lax");
  });
});
