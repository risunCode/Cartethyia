import { returningRows, assertMutationApplied } from "./row-coercion";
import type { ConsoleCredentialService } from "./credentials";
import { readUsers } from "./user-store";
// Console authentication, sessions, lockouts, first-boot setup, and audit.
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  apiKeys,
  consoleUsers,
  tenants,
} from "../../persistence/schema";

import { firstBootSetupLock } from "../../persistence/dialect";
import { hashSecret, encryptCredential } from "../../security/crypto";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { DEFAULT_API_KEY_LABEL, DEFAULT_API_KEY_PREFIX } from "../api-keys/contracts";
import { resolveDefaultGatewayApiKey } from "../../config/runtime";
import { TENANT_KEY_SCOPES } from "../../security/access-control";
import { isRecord } from "../../protocol/codecs";
import { BackupService } from "../backup/service";
import type { BackupInspection } from "../backup/service";
import type { RestoreWarning } from "../backup/contracts";

// Resolved at call time, not import time: the dialect depends on the mode,
// and the mode is read from the environment the process was started with.

/** The administrator to create when a restored backup left none to sign in with. */
export interface AdminBootstrap {
  readonly password: string;
  readonly username?: string;
  readonly displayName?: string;
}

/** What a first-boot restore did, so the console can report it honestly. */
export interface RestoreBackupOutcome {
  readonly restored: Record<string, number>;
  readonly skipped: Record<string, number>;
  /** Parts of the file that could not be restored. */
  readonly warnings: readonly RestoreWarning[];
  /** Whether the file's own accounts are what will sign in from now on. */
  readonly hasConsoleUsers: boolean;
  /** Whether this restore had to create an administrator to stay reachable. */
  readonly createdAdmin: boolean;
}

export class FirstBootSetupService {
  /**
   * Single-flight guard. Typed as `unknown`-resolving because setup and restore
   * return different shapes (`void` and an outcome), and the guard only ever
   * awaits them to serialize callers — it never reads a value.
   */
  private setupInFlight: Promise<unknown> | undefined;
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

      await this.createConsoleUser(db, tenantId, password, username, displayName);
      const defaultApiKey = resolveDefaultGatewayApiKey();
      // The gateway key is mandatory, not optional: routing keys every request
      // off it, and the CLI reads it from there. When `CARTETHYIA_API_KEY` is
      // unset the secret is generated here with the same strength as the
      // encryption key, so an install that never touched the variable still
      // boots with a usable key instead of failing later with
      // "the default gateway API key is missing".
      const secret = defaultApiKey ?? `${DEFAULT_API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
      const keyHash = hashSecret(secret);
      const existingApiKey = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.isDefault, true)))
        .limit(1);
      if (existingApiKey.length === 0) {
        await db.insert(apiKeys).values({
          id: randomUUID(),
          tenantId,
          keyHash,
          label: DEFAULT_API_KEY_LABEL,
          scopes: TENANT_KEY_SCOPES,
          keyPrefix: secret.slice(0, 3),
          keyEncrypted: encryptCredential(secret),
          requestsPerMinute: 240,
          isDefault: true,
        });
      }
    };

    // First boot creates the default tenant, the platform-admin user, and the
    // gateway key. The advisory lock is what stops two concurrent boots from
    // both passing the "no admin yet" check and racing to create them, so a
    // handle that cannot take the lock must fail closed — the previous
    // `typeof` probe skipped the lock and ran the setup unserialized.
    await this.db.transaction(async (transaction) => {
      await transaction.execute(firstBootSetupLock());
      await create(transaction as unknown as CartethyiaDatabase);
    });
  }

  /**
   * Describes a backup file without restoring it.
   *
   * The first-boot wizard peeks before it commits, and "which of these tables
   * does this build actually have" is a question only the live schema can
   * answer. Gated on first boot by the route, so it is not readable once an
   * account exists.
   */
  inspectBackup(payload: unknown): BackupInspection {
    const backup = new BackupService({ db: this.db, verifyPassword: async () => false });
    return backup.inspect(payload);
  }

  /**
   * First boot from a backup. Creates an empty tenant, then restores the file
   * into it.
   *
   * The restore is partial by contract — a file from an older build recovers
   * what still matches the schema and reports the rest — so this never refuses a
   * backup for being incomplete. When the file carried no console user (or none
   * that survived), the restored configuration would otherwise be unreachable:
   * nobody could sign in to it. So this path then creates an administrator from
   * `admin`, which the caller only supplies when the file left the console
   * without an account. Refuses once any user exists, same as setup.
   */
  async restoreBackup(payload: unknown, admin?: AdminBootstrap): Promise<RestoreBackupOutcome> {
    const previous = this.setupInFlight;
    if (previous) await previous.catch(() => undefined);
    const operation = this.restoreBackupOnce(payload, admin);
    this.setupInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.setupInFlight === operation) this.setupInFlight = undefined;
    }
  }

  private async restoreBackupOnce(payload: unknown, admin?: AdminBootstrap): Promise<RestoreBackupOutcome> {
    if (!(await this.requiresSetup())) throw new Error("Setup already completed");
    const tenantId = randomUUID();
    await this.db.insert(tenants).values({ id: tenantId, name: "Default", status: "active" });
    let result: Awaited<ReturnType<BackupService["restoreFirstBoot"]>>;
    try {
      const backup = new BackupService({
        db: this.db,
        verifyPassword: async () => false,
      });
      result = await backup.restoreFirstBoot(payload, tenantId);
    } catch (error) {
      await this.db.delete(tenants).where(eq(tenants.id, tenantId));
      throw error;
    }

    // The file left nobody to sign in with. Create the administrator rather
    // than discarding a restore that worked, so the operator keeps the
    // configuration and still gets a console.
    if (!(await this.requiresSetup())) {
      return { ...result, createdAdmin: false };
    }
    if (admin === undefined || admin.password.length === 0) {
      // Nothing forced the caller to supply one: it did not know the file was
      // missing users until now. Roll the tenant back so a retry is clean, and
      // say exactly what is needed.
      await this.db.delete(tenants).where(eq(tenants.id, tenantId));
      throw new Error("Backup has no console users; set an administrator username and password to finish");
    }
    try {
      await this.createConsoleUser(
        this.db,
        tenantId,
        admin.password,
        admin.username,
        admin.displayName,
      );
    } catch (error) {
      await this.db.delete(tenants).where(eq(tenants.id, tenantId));
      throw error;
    }
    return { ...result, createdAdmin: true };
  }

  /**
   * Inserts one platform-admin console user.
   *
   * Shared by plain setup and by a restore that left the console without an
   * account, so the two cannot drift into different admin shapes.
   */
  private async createConsoleUser(
    db: CartethyiaDatabase,
    tenantId: string,
    password: string,
    username?: string,
    displayName?: string,
  ): Promise<void> {
    const adminUsername = username?.trim() || "admin";
    const passwordHash = await this.credentialService.hashPassword(password);
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
  }
}

/** One privileged console mutation to record. */
