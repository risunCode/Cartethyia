/**
 * Canonical console session-cookie parsing and access resolution.
 * This module is the only session resolver used by console routes.
 */
import { eq } from "drizzle-orm";
import { parseCookieValue, SESSION_COOKIE_NAME } from "../../security/csrf";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { consoleUsers } from "../../persistence/schema";
import { createAccessDecision, consoleSessionScopes, type AccessDecision } from "../../security/access-control";
import { isRecord } from "../../protocol/primitives";
import type { ConsoleSessionService } from "./service";

interface CookieLike {
  readonly value?: unknown;
}

/**
 * Parses the `session_token` cookie from Elysia's typed cookie jar (the
 * `cookie` context property available in route handlers). Used wherever a
 * handler already has `cookie` destructured, rather than re-parsing the raw
 * header.
 */
export function readSessionCookie(cookies: unknown): string | undefined {
  if (!isRecord(cookies)) return undefined;
  const cookie = cookies.session_token;
  if (!isRecord(cookie)) return undefined;
  const value = (cookie as unknown as CookieLike).value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolves a dashboard session cookie to the signed-in user's real tenant and scopes. */
export async function resolveConsoleAccess(
  db: CartethyiaDatabase,
  sessionService: ConsoleSessionService,
  request: Request,
): Promise<AccessDecision | undefined> {
  const user = await resolveConsoleUser(db, sessionService, request);
  if (user === null) return undefined;
  return createAccessDecision({
    id: user.sessionId,
    tenantId: user.tenantId,
    scopes: consoleSessionScopes(user.isPlatformAdmin),
    admissionIdentity: user.id,
  });
}

/** The signed-in console user behind a request, or `null` when unauthenticated. */
export interface ResolvedConsoleUser {
  readonly id: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly passwordHash: string;
  readonly isPlatformAdmin: boolean;
}

/**
 * Resolves the console user a request's session cookie belongs to.
 *
 * Separate from {@link resolveConsoleAccess} because a surface can need the
 * user row itself — backup re-authentication verifies the operator's password —
 * without the scope decision that access resolution derives from it.
 */
export async function resolveConsoleUser(
  db: CartethyiaDatabase,
  sessionService: ConsoleSessionService,
  request: Request,
): Promise<ResolvedConsoleUser | null> {
  const token = parseCookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const session = await sessionService.validateSession(token);
  if (!session) return null;
  const rows = await db
    .select()
    .from(consoleUsers)
    .where(eq(consoleUsers.id, session.userId))
    .limit(1);
  const user = rows[0];
  if (!user || !user.isActive) return null;
  return {
    id: user.id,
    sessionId: session.id,
    tenantId: user.tenantId,
    passwordHash: user.passwordHash,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}
