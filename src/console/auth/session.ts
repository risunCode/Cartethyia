import { asCookie, clearCsrfCookie, newCsrfToken, setCsrfCookie } from "../../security/csrf";
import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import { isRecord } from "../../protocol/primitives";
import {
  userRecord,
  readUsers,
  readUser,
  returningRows,
  assertMutationApplied,
} from "./service";
import { consoleUsers, adminAuditLog } from "../../persistence/schema";
import type { ConsoleCredentialService } from "./service";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import {
  type SessionCookiePolicy,
  defaultSessionCookiePolicy,
  type ConsoleSessionService,
} from "./service";
import type { ConsoleLockoutService } from "./service";
import type { FirstBootSetupService } from "./service";
import { isTrustedProxyPeer, resolveClientIdentity } from "../../security/ip-boundary";
import type { TrustedProxyBoundary } from "../../config";
import { readSessionCookie } from "./session-resolver";
export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly status: "success" | "failed";
  /** Session secrets are cookie-only and are never returned in JSON. */
  readonly session_id?: never;
  readonly user_id?: string;
  readonly requires_setup?: boolean;
  readonly message?: string;
}

/**
 * `GET /session` body. Discriminated on `status` rather than one flat bag of
 * optionals: the route always emits every authenticated field together, so a
 * flat interface let the dashboard's hand-written mirror omit `username` and
 * mark three fields required without a compile error. Both sides now project
 * this declaration.
 */
export type SessionStatusResponse =
  | {
      readonly status: "authenticated";
      readonly user_id: string;
      readonly username: string;
      readonly email: string;
      readonly display_name: string | null;
      readonly is_first_boot: boolean;
      readonly session_expires_at: string;
      readonly is_platform_admin: boolean;
    }
  | { readonly status: "unauthenticated" };

export interface SetupRequest {
  readonly password: string;
  readonly username?: string;
  readonly display_name?: string;
}

export interface SetupResponse {
  readonly status: "success" | "failed";
  readonly message?: string;
}

export interface LogoutResponse {
  readonly status: "success";
}

export interface ChangePasswordResponse {
  readonly status: "success" | "failed";
  readonly message?: string;
}


function cookieOptions(
  policy: SessionCookiePolicy,
  value: string,
  maxAge: number,
): Record<string, unknown> {
  return {
    value,
    maxAge,
    httpOnly: policy.httpOnly,
    sameSite: policy.sameSite.toLowerCase(),
    secure: policy.secure,
    path: "/",
  };
}

function setSessionCookie(cookies: unknown, policy: SessionCookiePolicy, value: string): void {
  if (!isRecord(cookies)) throw new Error("Session cookie support is unavailable");
  const cookie = asCookie(cookies.session_token);
  if (!cookie || typeof cookie.set !== "function") {
    throw new Error("Session cookie support is unavailable");
  }
  cookie.set(cookieOptions(policy, value, policy.maxAge));
}

/**
 * Upgrades the cookie policy to Secure when the request arrived over TLS
 * through a trusted reverse proxy. The boot-time policy only sees the
 * origin string; behind a TLS-terminating proxy the origin may read http
 * while the client leg is https, and a non-Secure session cookie would
 * then travel in the clear. Forwarded protocol is honored only inside the
 * trusted-proxy boundary (same trust model as client-IP resolution).
 */
export function securePolicyForRequest(
  request: Request,
  policy: SessionCookiePolicy,
  trustedProxyBoundary: TrustedProxyBoundary,
  peerAddress: string | undefined,
): SessionCookiePolicy {
  if (policy.secure) return policy;
  if (request.url.startsWith("https://")) return { ...policy, secure: true };
  // Behind a TLS-terminating proxy the origin may read http while the client
  // leg is https: upgrade only on a trusted peer's explicit say-so, never on
  // a bare client-sent header.
  if (peerAddress === undefined || !isTrustedProxyPeer(peerAddress, trustedProxyBoundary)) {
    return policy;
  }
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null && forwarded.split(",")[0]?.trim().toLowerCase() === "https") {
    return { ...policy, secure: true };
  }
  return policy;
}

function clearSessionCookie(cookies: unknown, policy: SessionCookiePolicy): void {
  if (!isRecord(cookies)) return;
  const cookie = asCookie(cookies.session_token);
  if (!cookie || typeof cookie.set !== "function") return;
  cookie.set({ ...cookieOptions(policy, "", 0), expires: new Date(0) });
}

function parseLoginRequest(body: unknown): LoginRequest | undefined {
  if (!isRecord(body) || typeof body.password !== "string") {
    return undefined;
  }
  const username =
    typeof body.username === "string"
      ? body.username.trim()
      : typeof body.email === "string"
        ? body.email.trim()
        : undefined;
  if (!username) return undefined;
  return { username, password: body.password };
}

function parseSetupRequest(body: unknown): SetupRequest | undefined {
  if (!isRecord(body) || typeof body.password !== "string") return undefined;
  if (body.username !== undefined && typeof body.username !== "string") return undefined;
  if (body.display_name !== undefined && typeof body.display_name !== "string") return undefined;
  return {
    password: body.password,
    ...(body.username === undefined ? {} : { username: body.username.trim() }),
    ...(body.display_name === undefined ? {} : { display_name: body.display_name.trim() }),
  };
}

export function createConsoleAuthRoutes(
  db: CartethyiaDatabase,
  credentialService: ConsoleCredentialService,
  sessionService: ConsoleSessionService,
  lockoutService: ConsoleLockoutService,
  setupService: FirstBootSetupService,
  cookiePolicy: SessionCookiePolicy = defaultSessionCookiePolicy,
  trustedProxyBoundary: TrustedProxyBoundary = { mode: "disabled" },
  resolvePeerAddress: (request: Request) => string | undefined = () => undefined,
): Elysia {
  const app = new Elysia({ prefix: "/auth" });
  const policy = cookiePolicy;
  const database = db;

  app.post(
    "/login",
    {
      body: t.Object({
        username: t.Optional(t.String()),
        email: t.Optional(t.String()),
        password: t.String(),
      }),
    },
    async ({ body, request, cookie, set }) => {
      const peerAddress = resolvePeerAddress(request);
      if (!peerAddress) {
        set.status = 503;
        return {
          status: "failed",
          message: "Console client identity is unavailable",
        } satisfies LoginResponse;
      }
      const clientIp = resolveClientIdentity(request, trustedProxyBoundary, peerAddress);
      const input = parseLoginRequest(body);
      const loginIdentifier = input?.username.trim().toLowerCase() ?? "<invalid>";
      const lockoutKey = `${loginIdentifier}:${clientIp}`;
      const remainingLock = await lockoutService.remainingLockSeconds(lockoutKey);
      if (remainingLock > 0) {
        set.status = 429;
        set.headers["retry-after"] = String(remainingLock);
        return {
          status: "failed",
          message: "This login is temporarily blocked due to repeated authentication failures.",
        } satisfies LoginResponse;
      }

      if (!input?.username || !input.password) {
        await lockoutService.recordFailure(lockoutKey, "missing_fields");
        set.status = 400;
        return {
          status: "failed",
          message: "Missing username or password",
        } satisfies LoginResponse;
      }

      const rows = await readUsers(database, input.username);
      const user = userRecord(rows[0]);
      if (!user || !user.isActive) {
        const isBanned = await lockoutService.recordFailure(lockoutKey, "unknown_user");
        if (isBanned) {
          set.status = 429;
          set.headers["retry-after"] = String(await lockoutService.remainingLockSeconds(lockoutKey));
          return {
            status: "failed",
            message: "This login has been blocked due to repeated failed authentication attempts.",
          } satisfies LoginResponse;
        }
        set.status = 401;
        return { status: "failed", message: "Invalid credentials" } satisfies LoginResponse;
      }

      const valid = await credentialService.verifyPassword(input.password, user.passwordHash);
      if (!valid) {
        const isBanned = await lockoutService.recordFailure(lockoutKey, "invalid_password");
        if (isBanned) {
          set.status = 429;
          set.headers["retry-after"] = String(await lockoutService.remainingLockSeconds(lockoutKey));
          return {
            status: "failed",
            message: "This login has been blocked due to repeated failed authentication attempts.",
          } satisfies LoginResponse;
        }
        set.status = 401;
        return { status: "failed", message: "Invalid credentials" } satisfies LoginResponse;
      }

      await lockoutService.clearFailures(lockoutKey);
      const session = await sessionService.createSession(
        user.id,
        clientIp,
        request.headers.get("user-agent") ?? "",
      );
      const effectivePolicy = securePolicyForRequest(request, policy, trustedProxyBoundary, peerAddress);
      setSessionCookie(cookie, effectivePolicy, session.sessionToken);
      setCsrfCookie(cookie, effectivePolicy, newCsrfToken());
      set.status = 200;
      return {
        status: "success",
        user_id: user.id,
        requires_setup: user.isFirstBoot,
      } satisfies LoginResponse;
    },
  );

  app.get("/session", async ({ cookie }) => {
    const sessionToken = readSessionCookie(cookie);
    if (!sessionToken) return { status: "unauthenticated" } satisfies SessionStatusResponse;
    const session = await sessionService.validateSession(sessionToken);
    if (!session) return { status: "unauthenticated" } satisfies SessionStatusResponse;

    const user = userRecord(await readUser(database, session.userId));
    if (!user || !user.isActive) {
      await sessionService.deleteSession(sessionToken);
      clearSessionCookie(cookie, policy);
      clearCsrfCookie(cookie, policy);
      return { status: "unauthenticated" } satisfies SessionStatusResponse;
    }
    return {
      status: "authenticated",
      user_id: user.id,
      username: user.username,
      email: user.email ?? user.username,
      display_name: user.displayName ?? null,
      is_first_boot: user.isFirstBoot,
      session_expires_at: session.expiresAt.toISOString(),
      is_platform_admin: user.isPlatformAdmin,
    } satisfies SessionStatusResponse;
  });

  app.post("/logout", async ({ cookie, set }) => {
    const sessionToken = readSessionCookie(cookie);
    if (sessionToken) await sessionService.deleteSession(sessionToken);
    clearSessionCookie(cookie, policy);
    clearCsrfCookie(cookie, policy);
    set.status = 200;
    return { status: "success" } satisfies LogoutResponse;
  });


  app.get("/first-boot", async ({ set }) => {
    set.status = 200;
    return { requires_setup: await setupService.requiresSetup() };
  });

  app.post(
    "/setup",
    {
      body: t.Object({
        password: t.String(),
        username: t.Optional(t.String()),
        display_name: t.Optional(t.String()),
      }),
    },
    async ({ body, set }) => {
      const input = parseSetupRequest(body);
      if (!input || input.password.length === 0) {
        set.status = 400;
        return { status: "failed", message: "Password is required" } satisfies SetupResponse;
      }
      if (!(await setupService.requiresSetup())) {
        set.status = 400;
        return { status: "failed", message: "Setup already completed" } satisfies SetupResponse;
      }
      try {
        await setupService.completeSetup(input.password, input.username, input.display_name);
      } catch (error) {
        if (error instanceof Error && error.message === "Setup already completed") {
          set.status = 400;
          return { status: "failed", message: error.message } satisfies SetupResponse;
        }
        throw error;
      }
      return { status: "success", message: "Setup completed" } satisfies SetupResponse;
    },
  );

  app.post(
    "/change-password",
    {
      body: t.Object({
        currentPassword: t.String(),
        newPassword: t.String(),
      }),
    },
    async ({ body, cookie, set }) => {
      const sessionToken = readSessionCookie(cookie);
      if (!sessionToken) {
        set.status = 401;
        return { status: "failed", message: "Not authenticated" } satisfies ChangePasswordResponse;
      }
      const session = await sessionService.validateSession(sessionToken);
      if (!session) {
        set.status = 401;
        return { status: "failed", message: "Session expired" } satisfies ChangePasswordResponse;
      }
      const user = userRecord(await readUser(database, session.userId));
      if (!user || !user.isActive) {
        set.status = 401;
        return { status: "failed", message: "Not authenticated" } satisfies ChangePasswordResponse;
      }
      const { currentPassword, newPassword } = body;
      if (newPassword.length < 8) {
        set.status = 400;
        return {
          status: "failed",
          message: "New password must be at least 8 characters",
        } satisfies ChangePasswordResponse;
      }
      const valid = await credentialService.verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        set.status = 401;
        return {
          status: "failed",
          message: "Current password is incorrect",
        } satisfies ChangePasswordResponse;
      }
      const newHash = await credentialService.hashPassword(newPassword);
      const rotateInScope = async (scope: CartethyiaDatabase): Promise<number> => {
        const result = await returningRows(
          scope
            .update(consoleUsers)
            .set({ passwordHash: newHash, updatedAt: new Date() })
            .where(eq(consoleUsers.id, user.id)),
        );
        assertMutationApplied(result, "Password change");
        const invalidated = await sessionService.deleteOtherSessions(
          user.id,
          session.id,
          scope,
        );
        await scope.insert(adminAuditLog).values({
          actor: user.id,
          action: "console.password_changed",
          target: user.id,
          detail: { sessionsInvalidated: invalidated },
        });
        return invalidated;
      };
      await database.transaction((tx) => rotateInScope(tx as unknown as CartethyiaDatabase));
      set.status = 200;
      return { status: "success" } satisfies ChangePasswordResponse;
    },
  );

  return app as unknown as Elysia;
}
