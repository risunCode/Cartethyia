// Console authentication, sessions, lockouts, first-boot setup, and audit.
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { ConsoleSession, ConsoleUser } from "../../persistence/schema";
import { log } from "../../observability/logger";
import {
  adminAuditLog,
  apiKeys,
  consoleLockouts,
  consoleSessions,
  consoleUsers,
  tenants,
} from "../../persistence/schema";
import { hashSecret, encryptCredential } from "../../security/crypto";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { DEFAULT_API_KEY_LABEL } from "../domains/api-keys/contracts";
import { resolveDefaultGatewayApiKey } from "../../config";
import type { AccessDecision } from "../../security/access-control";
import { isRecord } from "../../protocol/primitives";

// ---- auth-core.ts ----
// Persistence types use CartethyiaDatabase (persistence/postgres.ts), the
// single Postgres boundary. The Drizzle transaction callback receives a
// PgTransaction and is cast at that one boundary — same pattern as
// providers/operations/account-health-service.ts.

export function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

export function sessionRecord(value: unknown): ConsoleSession | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.sessionToken !== "string"
  ) {
    return undefined;
  }
  const expiresAt = asDate(value.expiresAt);
  const createdAt = asDate(value.createdAt);
  if (!expiresAt || !createdAt) return undefined;
  return { ...value, expiresAt, createdAt } as unknown as ConsoleSession;
}

export function userRecord(value: unknown): ConsoleUser | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.username !== "string" ||
    typeof value.passwordHash !== "string" ||
    typeof value.isActive !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as ConsoleUser;
}

export function mutationAffectedRows(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["rowCount", "rowsAffected", "changes"] as const) {
    const count = value[key];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  return undefined;
}

/** Awaitable Drizzle mutation builder that may expose `.returning()`. */
export interface ReturningBuilder extends PromiseLike<unknown> {
  returning?: (...columns: unknown[]) => PromiseLike<unknown[]>;
}

export async function returningRows(
  builder: ReturningBuilder,
): Promise<{ rows: unknown[]; supported: boolean; affectedRows?: number }> {
  if (typeof builder.returning === "function") {
    return { rows: await builder.returning(), supported: true };
  }
  const result = await builder;
  const affectedRows = mutationAffectedRows(result);
  return affectedRows === undefined
    ? { rows: [], supported: false }
    : { rows: [], supported: false, affectedRows };
}

export function assertMutationApplied(
  result: { rows: unknown[]; supported: boolean; affectedRows?: number },
  operation: string,
): void {
  const applied = result.supported ? result.rows.length > 0 : result.affectedRows === 1;
  if (!applied) throw new Error(`${operation} was not persisted`);
}

export class ConsoleUserStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async findByUsername(username: string): Promise<unknown | undefined> {
    const rows = await this.db.select().from(consoleUsers).where(eq(consoleUsers.username, username)).limit(1);
    return rows[0];
  }

  async findById(userId: string): Promise<unknown | undefined> {
    const rows = await this.db.select().from(consoleUsers).where(eq(consoleUsers.id, userId)).limit(1);
    return rows[0];
  }

  async findAny(): Promise<unknown[]> {
    return this.db.select().from(consoleUsers).limit(1);
  }
}

export async function readUsers(db: CartethyiaDatabase, username?: string): Promise<unknown[]> {
  const store = new ConsoleUserStore(db);
  if (username === undefined) return store.findAny();
  const user = await store.findByUsername(username);
  return user ? [user] : [];
}
export async function readUser(db: CartethyiaDatabase, userId: string): Promise<unknown> {
  return new ConsoleUserStore(db).findById(userId);
}

// ---- credentials.ts ----
const ARGON2ID_PREFIX = "$argon2id$";

export class ConsoleCredentialService {
  /**
   * Hashes a console password with argon2id via Bun's native implementation:
   * the OWASP-recommended password KDF here, chosen over the HMAC-SHA256
   * `hashSecret` used for API keys because passwords are low-entropy user
   * material and need a memory-hard KDF to resist offline brute force. The
   * 64 MiB / t=3 tuning balances brute-force resistance against the console
   * login latency budget; salt and parameters are embedded in the returned
   * PHC string so future rehashing can migrate costs without a data migration.
   */
  async hashPassword(password: string): Promise<string> {
    if (typeof password !== "string" || password.length === 0) {
      throw new Error("Password must not be empty");
    }
    return Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: 65536,
      timeCost: 3,
    });
  }

  /**
   * Constant-time verification against an argon2id PHC string. Deliberately
   * returns `false` instead of throwing for malformed, non-argon2id, or
   * undecodable hashes: a corrupted `password_hash` row must surface as an
   * ordinary failed login (counted by the lockout service), never as a 500
   * that lets an attacker probe hash integrity or bypass the failure counter.
   * Legacy/migrated hashes are rejected here rather than verified — a hash
   * that does not start with `$argon2id$` can only originate from a foreign
   * scheme this deployment never issued.
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (
      typeof password !== "string" ||
      typeof hash !== "string" ||
      !hash.startsWith(ARGON2ID_PREFIX)
    ) {
      return false;
    }
    try {
      return await Bun.password.verify(password, hash);
    } catch {
      return false;
    }
  }
}

// Console sessions are opaque, hashed database tokens — not JWTs. The cookie
// and database expiry share one policy so a successful login remains valid for
// the full local/deployed session window.
export interface SessionCookiePolicy {
  readonly maxAge: number;
  readonly httpOnly: boolean;
  readonly sameSite: "Lax" | "Strict" | "None";
  readonly secure: boolean;
}

const SESSION_MAX_AGE_SECONDS = 48 * 60 * 60;

function shouldUseSecureSessionCookie(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return process.env.CARTETHYIA_PUBLIC_ORIGIN?.startsWith("https://") === true;
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

export class ConsoleLockoutStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async getLockedUntil(ip: string): Promise<Date | null | undefined> {
    const rows = await this.db
      .select({ lockedUntil: consoleLockouts.lockedUntil })
      .from(consoleLockouts)
      .where(eq(consoleLockouts.ip, ip))
      .limit(1);
    return rows[0]?.lockedUntil;
  }

  async upsertFailure(
    ip: string,
    reason: string,
    now: Date,
    windowUntil: Date,
  ): Promise<number> {
    const rows = await this.db
      .insert(consoleLockouts)
      .values({ ip, failureCount: 1, windowUntil, reason, updatedAt: now })
      .onConflictDoUpdate({
        target: consoleLockouts.ip,
        set: {
          // Within the sliding failure window: increment. Window expired: reset to 1.
          failureCount: sql`CASE WHEN ${consoleLockouts.windowUntil} > ${now} THEN ${consoleLockouts.failureCount} + 1 ELSE 1 END`,
          windowUntil: sql`CASE WHEN ${consoleLockouts.windowUntil} > ${now} THEN ${consoleLockouts.windowUntil} ELSE ${windowUntil} END`,
          reason,
          updatedAt: now,
        },
      })
      .returning({ failureCount: consoleLockouts.failureCount });
    return rows[0]?.failureCount ?? 1;
  }

  async lock(ip: string, lockedUntil: Date, now: Date): Promise<void> {
    await this.db
      .update(consoleLockouts)
      .set({ lockedUntil, updatedAt: now })
      .where(eq(consoleLockouts.ip, ip));
  }

  async clearFailures(ip: string): Promise<void> {
    await this.db.delete(consoleLockouts).where(eq(consoleLockouts.ip, ip));
  }
}

export class ConsoleLockoutService {
  private readonly maxFailures: number;
  private readonly lockoutDurationMs: number;
  private readonly failureWindowMs = 15 * 60 * 1000;
  private readonly store: ConsoleLockoutStore;

  constructor(
    private readonly db: CartethyiaDatabase,
    maxFailures = 5,
    lockoutDurationMs = 60 * 60 * 1000,
  ) {
    this.store = new ConsoleLockoutStore(db);
    this.maxFailures = maxFailures;
    this.lockoutDurationMs = lockoutDurationMs;
  }

  /**
   * Whole seconds remaining on `ip`'s lock, or `0` when it is not locked.
   *
   * The login route reports this as `retry-after`. The lock is a fixed window
   * from the last failure, so the real wait shrinks toward zero while a
   * hardcoded value never does — every client that retried partway through a
   * lock was told to wait the full duration again. A locked row always reports
   * at least one second, because a 429 must not carry `retry-after: 0`.
   */
  async remainingLockSeconds(ip: string, now = Date.now()): Promise<number> {
    const lockedUntil = await this.store.getLockedUntil(ip);
    if (lockedUntil === null || lockedUntil === undefined) return 0;
    const remainingMs = lockedUntil.getTime() - now;
    return remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0;
  }

  async isLocked(ip: string): Promise<boolean> {
    return (await this.remainingLockSeconds(ip)) > 0;
  }

  async recordFailure(ip: string, reason: string): Promise<boolean> {
    if (await this.isLocked(ip)) return true;

    const now = new Date();
    const windowUntil = new Date(now.getTime() + this.failureWindowMs);
    const count = await this.store.upsertFailure(ip, reason, now, windowUntil);
    if (count < this.maxFailures) return false;

    const lockedUntil = new Date(now.getTime() + this.lockoutDurationMs);
    await this.store.lock(ip, lockedUntil, now);
    await this.logBanAudit(ip, reason, count, this.lockoutDurationMs);
    return true;
  }

  private async logBanAudit(
    ip: string,
    reason: string,
    attempts: number,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.db.insert(adminAuditLog).values({
        id: randomUUID(),
        actor: "system:ip_guard",
        action: "security.ip_banned",
        target: `ip:${ip}`,
        detail: {
          ip,
          reason,
          failed_attempts: attempts,
          ttl_seconds: Math.floor(durationMs / 1000),
          banned_until: new Date(Date.now() + durationMs).toISOString(),
          enforcement: "full_network_lockout",
        },
      });
    } catch {
      // Best-effort audit logging; the ban itself remains enforced via the DB row.
    }
  }

  async clearFailures(ip: string): Promise<void> {
    await this.store.clearFailures(ip);
  }
}




const FIRST_BOOT_SETUP_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('cartethyia:first_boot_setup'))`;

export class FirstBootSetupService {
  private setupInFlight: Promise<void> | undefined;
  private readonly db: CartethyiaDatabase;

  constructor(
    db: CartethyiaDatabase,
    private readonly credentialService: ConsoleCredentialService,
  ) {
    this.db = db;
  }

  async requiresSetup(): Promise<boolean> {
    const existing = await readUsers(this.db);
    return existing.length === 0;
  }

  /**
   * First-boot initialization: creates the default tenant, the first
   * platform-admin console user, the default gateway API key from
   * `CARTETHYIA_API_KEY` (when set), and the tenant's default Filter Sanitize
   * rules — all in one transaction guarded by a PostgreSQL advisory
   * transaction lock, so two concurrent first-boot requests cannot each
   * create an admin.
   *
   * Concurrency is two-layered: the advisory lock serializes competing
   * *processes* on the same database, while the in-process `setupInFlight`
   * single-flight prevents a rejected second caller (which would fail the
   * "Setup already completed" check) from surfacing an error during a race.
   * A re-check inside the transaction still rejects any setup that races a
   * committed one.
   */
  async completeSetup(password: string, username?: string, displayName?: string): Promise<void> {
    const previous = this.setupInFlight;
    if (previous) await previous.catch(() => undefined);

    const operation = this.completeSetupOnce(password, username, displayName);
    this.setupInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.setupInFlight === operation) this.setupInFlight = undefined;
    }
  }

  private async completeSetupOnce(
    password: string,
    username?: string,
    displayName?: string,
  ): Promise<void> {
    const create = async (db: CartethyiaDatabase): Promise<void> => {
      const existing = await readUsers(db);
      if (existing.length > 0) throw new Error("Setup already completed");

      const tenantRows = await db.select().from(tenants).limit(1);
      const existingTenant = tenantRows[0];
      let tenantId =
        isRecord(existingTenant) && typeof existingTenant.id === "string"
          ? existingTenant.id
          : undefined;

      if (!tenantId) {
        const candidateId = randomUUID();
        const tenantInsert = db.insert(tenants).values({
          id: candidateId,
          name: "Default",
          status: "active",
        });
        const insertedTenant = await returningRows(tenantInsert);
        assertMutationApplied(insertedTenant, "Default tenant");
        const inserted = insertedTenant.rows[0];
        tenantId =
          isRecord(inserted) && typeof inserted.id === "string" ? inserted.id : candidateId;
      }

      const passwordHash = await this.credentialService.hashPassword(password);
      const adminUsername = username?.trim() || "admin";
      const userInsert = db.insert(consoleUsers).values({
        id: randomUUID(),
        tenantId,
        username: adminUsername,
        email: `${adminUsername}@localhost`,
        passwordHash,
        displayName: displayName?.trim() || "Administrator",
        isFirstBoot: false,
        isActive: true,
        isPlatformAdmin: true,
      });
      const insertedUser = await returningRows(userInsert);
      assertMutationApplied(insertedUser, "Administrator user");
      const defaultApiKey = resolveDefaultGatewayApiKey();
      if (defaultApiKey) {
        const keyHash = hashSecret(defaultApiKey);
        const existingApiKey = await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.keyHash, keyHash)))
          .limit(1);
        if (existingApiKey.length === 0) {
          const prefix = defaultApiKey.slice(0, 3);
          await db.insert(apiKeys).values({
            id: randomUUID(),
            tenantId,
            keyHash,
            label: DEFAULT_API_KEY_LABEL,
            scopes: ["routing:invoke"],
            keyPrefix: prefix,
            keyEncrypted: encryptCredential(defaultApiKey),
            requestsPerMinute: 240,
          });
        }
      }
    };

    // First boot creates the default tenant, the platform-admin user, and the
    // gateway key. The advisory lock is what stops two concurrent boots from
    // both passing the "no admin yet" check and racing to create them, so a
    // handle that cannot take the lock must fail closed — the previous
    // `typeof` probe skipped the lock and ran the setup unserialized.
    await this.db.transaction(async (transaction) => {
      await transaction.execute(FIRST_BOOT_SETUP_LOCK);
      await create(transaction as unknown as CartethyiaDatabase);
    });
  }
}

/** One privileged console mutation to record. */
export interface AuditRecordInput {
  readonly access: AccessDecision;
  readonly action: string;
  readonly target: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Writes one row per privileged console mutation to `admin_audit_log`.
 * Best-effort: a logging failure never blocks the mutation it describes,
 * but is always surfaced to stderr so an operator can detect a silently
 * broken audit trail.
 */
const MAX_AUDIT_DETAIL_VALUE_BYTES = 1024;

/**
 * The audit trail needs who/what/when, not full payloads: values serializing
 * beyond 1 KiB (often whole rule/target snapshots) are replaced with a
 * byte-size marker. This is the actual storage cut — detail blobs are
 * frequently 50-90% of row size.
 */
function stripAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(value) ?? "");
    } catch {
      size = MAX_AUDIT_DETAIL_VALUE_BYTES + 1;
    }
    out[key] =
      size > MAX_AUDIT_DETAIL_VALUE_BYTES ? `[audit detail trimmed: ${size} bytes]` : value;
  }
  return out;
}

export class AuditRecorder {
  private readonly db: CartethyiaDatabase;

  constructor(db: CartethyiaDatabase) {
    this.db = db;
  }

  /**
   * The single audit entry point: call once per privileged console mutation
   * (create/update/delete of users, keys, pools, routes, settings) after the
   * mutation commits. There is deliberately no separate mutation variant —
   * every audit row carries the same who/what/when shape, and detail values
   * above `MAX_AUDIT_DETAIL_VALUE_BYTES` are replaced with a byte-size marker
   * (`stripAuditDetail`) to keep the log append-only-cheap rather than a
   * second copy of full entity snapshots.
   *
   * Fail-open by design: an audit write failure is logged but never blocks or
   * rolls back the mutation it describes.
   */
  async record(entry: AuditRecordInput): Promise<void> {
    try {
      if (typeof this.db?.insert === "function") {
        await this.db.insert(adminAuditLog).values({
          id: randomUUID(),
          actor: entry.access.admissionIdentity,
          ...(entry.access.tenantId ? { tenantId: entry.access.tenantId } : {}),
          action: entry.action,
          target: entry.target,
          ...(entry.detail ? { detail: stripAuditDetail(entry.detail) } : {}),
        });
      }
    } catch (error) {
      log.error("[audit] failed to record admin_audit_log entry", error as Error, entry.action);
    }
  }
}
