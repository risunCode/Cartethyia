import { returningRows, assertMutationApplied } from "./row-coercion";
import type { ConsoleCredentialService } from "./credentials";
import { readUsers } from "./user-store";
// Console authentication, sessions, lockouts, first-boot setup, and audit.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  apiKeys,
  consoleUsers,
  tenants,
} from "../../persistence/schema";

import { hashSecret, encryptCredential } from "../../security/crypto";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { DEFAULT_API_KEY_LABEL } from "../api-keys/contracts";
import { resolveDefaultGatewayApiKey } from "../../config/runtime";
import { TENANT_KEY_SCOPES } from "../../security/access-control";
import { isRecord } from "../../protocol/codecs";
import { BackupService } from "../backup/service";

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
            scopes: TENANT_KEY_SCOPES,
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

  /**
   * First boot from a backup. Creates an empty tenant, then restores the file
   * into it. The file's console users are the accounts that can sign in; this
   * path creates none of its own. Refuses once any user exists, same as setup.
   */
  async restoreBackup(payload: unknown): Promise<void> {
    const previous = this.setupInFlight;
    if (previous) await previous.catch(() => undefined);
    const operation = this.restoreBackupOnce(payload);
    this.setupInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.setupInFlight === operation) this.setupInFlight = undefined;
    }
  }

  private async restoreBackupOnce(payload: unknown): Promise<void> {
    if (!(await this.requiresSetup())) throw new Error("Setup already completed");
    const tenantId = randomUUID();
    await this.db.insert(tenants).values({ id: tenantId, name: "Default", status: "active" });
    try {
      const backup = new BackupService({
        db: this.db,
        verifyPassword: async () => false,
      });
      await backup.restoreFirstBoot(payload, tenantId);
    } catch (error) {
      await this.db.delete(tenants).where(eq(tenants.id, tenantId));
      throw error;
    }
    if (await this.requiresSetup()) {
      await this.db.delete(tenants).where(eq(tenants.id, tenantId));
      throw new Error("Backup did not restore a console user");
    }
  }
}

/** One privileged console mutation to record. */
