import { returningRows, assertMutationApplied, sessionRecord } from "./row-coercion";
// Console authentication, sessions, lockouts, first-boot setup, and audit.
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import type { ConsoleSession } from "../../persistence/schema";
import {
  consoleSessions,
} from "../../persistence/schema";

import { hashSecret } from "../../security/crypto";
import type { CartethyiaDatabase } from "../../persistence/db-handle";

export interface SessionCookiePolicy {
  readonly maxAge: number;
  readonly httpOnly: boolean;
  readonly sameSite: "Lax" | "Strict" | "None";
  readonly secure: boolean;
}

const SESSION_MAX_AGE_SECONDS = 48 * 60 * 60;

/**
 * Deletes sessions whose cookie has already expired. Reads filter them out,
 * but nothing removed the rows, so the table grew for the life of the
 * deployment. Bounded so one pass cannot hold a long lock.
 */
export async function deleteExpiredSessions(
  db: CartethyiaDatabase,
  now: Date = new Date(),
  limit = 1000,
): Promise<number> {
  const stale = await db
    .select({ id: consoleSessions.id })
    .from(consoleSessions)
    .where(lt(consoleSessions.expiresAt, now))
    .limit(limit);
  if (stale.length === 0) return 0;
  await db.delete(consoleSessions).where(inArray(consoleSessions.id, stale.map((row) => row.id)));
  return stale.length;
}

export function shouldUseSecureSessionCookie(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const origin = env.CARTETHYIA_PUBLIC_ORIGIN?.trim();
  if (origin) return origin.startsWith("https://");
  return env.NODE_ENV === "production";
}

export const defaultSessionCookiePolicy: SessionCookiePolicy = {
  maxAge: SESSION_MAX_AGE_SECONDS,
  httpOnly: true,
  sameSite: "Lax",
  secure: shouldUseSecureSessionCookie(),
};

function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export class ConsoleSessionStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async create(newSession: {
    id: string;
    userId: string;
    sessionToken: string;
    ipAddress: string | null;
    userAgent: string | null;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<ConsoleSession> {
    const inserted = await returningRows(this.db.insert(consoleSessions).values(newSession));
    assertMutationApplied(inserted, "Console session");
    const persisted = sessionRecord(inserted.rows[0]);
    return persisted ?? ({ ...newSession } as unknown as ConsoleSession);
  }

  async findValidByTokenHash(tokenHash: string, now: Date): Promise<ConsoleSession | null> {
    const rows = await this.db
      .select()
      .from(consoleSessions)
      .where(
        and(
          eq(consoleSessions.sessionToken, tokenHash),
          gt(consoleSessions.expiresAt, now),
        ),
      )
      .limit(1);
    const session = sessionRecord(rows[0]);
    if (!session || session.expiresAt.getTime() <= now.getTime()) return null;
    return session;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db
      .delete(consoleSessions)
      .where(eq(consoleSessions.sessionToken, tokenHash));
  }

  async deleteOtherSessions(
    userId: string,
    exceptSessionId: string,
    scope?: CartethyiaDatabase,
  ): Promise<number> {
    const db = scope ?? this.db;
    const removed = await returningRows(
      db
        .delete(consoleSessions)
        .where(
          and(eq(consoleSessions.userId, userId), ne(consoleSessions.id, exceptSessionId)),
        ),
    );
    if (removed.supported) return removed.rows.length;
    return removed.affectedRows ?? 0;
  }
}

export class ConsoleSessionService {
  private readonly store: ConsoleSessionStore;

  constructor(
    db: CartethyiaDatabase,
    private readonly cookiePolicy: SessionCookiePolicy,
  ) {
    this.store = new ConsoleSessionStore(db);
  }

  async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<ConsoleSession> {
    const rawToken = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.cookiePolicy.maxAge * 1000);
    const newSession = {
      id: randomUUID(),
      userId,
      sessionToken: hashSecret(rawToken),
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
      expiresAt,
      createdAt: now,
    };

    const session = await this.store.create(newSession);
    // Raw token is returned only to the route that sets the HttpOnly cookie.
    return { ...session, sessionToken: rawToken };
  }

  async validateSession(sessionToken: string): Promise<ConsoleSession | null> {
    if (typeof sessionToken !== "string" || sessionToken.length === 0) return null;
    const now = new Date();
    return this.store.findValidByTokenHash(hashSecret(sessionToken), now);
  }

  async deleteSession(sessionToken: string): Promise<void> {
    if (typeof sessionToken !== "string" || sessionToken.length === 0) return;
    await this.store.deleteByTokenHash(hashSecret(sessionToken));
  }

  /**
   * Invalidates every session for a user except the current one, returning
   * the invalidated count when the driver reports it. Runs against `scope`
   * so password rotation can share one transaction with the credential write.
   */
  async deleteOtherSessions(
    userId: string,
    exceptSessionId: string,
    scope?: CartethyiaDatabase,
  ): Promise<number> {
    return this.store.deleteOtherSessions(userId, exceptSessionId, scope);
  }
}
