// Persisted API-key store: the console API-key domain and gateway authentication both consume this boundary.

import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "./postgres";
import { apiKeys } from "./schema";
import type { AccessScope } from "../security/access-control";

/** Persisted key record. `keyHash` is the only credential material stored. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string;
  readonly label: string;
  readonly scopes: readonly AccessScope[];
  /** Public, non-secret leading fragment of the issued key. */
  readonly keyPrefix?: string;
  /**
   * Recoverable copy of the issued secret, AES-256-GCM encrypted with
   * `CARTETHYIA_ENCRYPTION_KEY`. Present only so the owner can share the key;
   * authentication always uses `keyHash`.
   */
  readonly keyEncrypted?: Buffer;
  /** Optional owner-authored copy rendered on the public share page. */
  readonly notesTitle?: string;
  readonly notesSubtitle?: string;
  readonly notesBody?: string;
  readonly requestsPerMinute?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly lifetimeTokenBudget?: number;
  readonly maxConcurrentRequests?: number;
  readonly modelPrefix?: string;
  readonly providerAllowlist?: readonly string[];
  readonly modelAllowlist?: readonly string[];
  readonly modelDenylist?: readonly string[];
  readonly createdAt: Date;
  readonly revokedAt?: Date;
  readonly tokensConsumed: number;
}

/**
 * Partial update patch. Notes and numeric limits accept `null` to clear the
 * stored value (back to unlimited); `undefined` leaves the field unchanged.
 */
export interface ApiKeyPatch
  extends Omit<
    Partial<ApiKeyRecord>,
    | "notesTitle"
    | "notesSubtitle"
    | "notesBody"
    | "requestsPerMinute"
    | "dailyTokenLimit"
    | "monthlyTokenLimit"
    | "lifetimeTokenBudget"
    | "maxConcurrentRequests"
  > {
  readonly notesTitle?: string | null;
  readonly notesSubtitle?: string | null;
  readonly notesBody?: string | null;
  readonly requestsPerMinute?: number | null;
  readonly dailyTokenLimit?: number | null;
  readonly monthlyTokenLimit?: number | null;
  readonly lifetimeTokenBudget?: number | null;
  readonly maxConcurrentRequests?: number | null;
}

/** Explicit persistence boundary. Production must provide this; there is no fallback store. */
export interface ApiKeyStore {
  list(tenantId: string): Promise<readonly ApiKeyRecord[]>;
  get(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined>;
  create(record: ApiKeyRecord): Promise<void>;
  update(tenantId: string, keyId: string, patch: ApiKeyPatch): Promise<ApiKeyRecord | undefined>;
  revoke(tenantId: string, keyId: string, revokedAt: Date): Promise<boolean>;
  findActiveByHash?(hash: string): Promise<typeof apiKeys.$inferSelect | undefined>;
}

export class DrizzleApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: CartethyiaDatabase) {}
  private map(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      keyHash: row.keyHash,
      label: row.label,
      scopes: row.scopes as ApiKeyRecord["scopes"],
      ...(row.keyPrefix === null ? {} : { keyPrefix: row.keyPrefix }),
      ...(row.keyEncrypted === null ? {} : { keyEncrypted: row.keyEncrypted }),
      ...(row.notesTitle === null ? {} : { notesTitle: row.notesTitle }),
      ...(row.notesSubtitle === null ? {} : { notesSubtitle: row.notesSubtitle }),
      ...(row.notesBody === null ? {} : { notesBody: row.notesBody }),
      ...(row.requestsPerMinute === null ? {} : { requestsPerMinute: row.requestsPerMinute }),
      ...(row.dailyTokenLimit === null ? {} : { dailyTokenLimit: row.dailyTokenLimit }),
      ...(row.monthlyTokenLimit === null ? {} : { monthlyTokenLimit: row.monthlyTokenLimit }),
      ...(row.lifetimeTokenBudget === null ? {} : { lifetimeTokenBudget: row.lifetimeTokenBudget }),
      ...(row.maxConcurrentRequests === null
        ? {}
        : { maxConcurrentRequests: row.maxConcurrentRequests }),
      ...(row.modelPrefix === null ? {} : { modelPrefix: row.modelPrefix }),
      ...(row.providerAllowlist === null
        ? {}
        : { providerAllowlist: row.providerAllowlist as string[] }),
      ...(row.modelAllowlist === null ? {} : { modelAllowlist: row.modelAllowlist as string[] }),
      ...(row.modelDenylist === null ? {} : { modelDenylist: row.modelDenylist as string[] }),
      createdAt: row.createdAt,
      ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
      tokensConsumed: row.lifetimeTokensConsumed,
    };
  }
  async list(tenantId: string): Promise<readonly ApiKeyRecord[]> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId));
    return rows.map((row) => this.map(row));
  }
  async get(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }
  async create(record: ApiKeyRecord): Promise<void> {
    await this.db.insert(apiKeys).values({
      id: record.id,
      tenantId: record.tenantId,
      keyHash: record.keyHash,
      label: record.label,
      scopes: record.scopes,
      keyPrefix: record.keyPrefix ?? null,
      keyEncrypted: record.keyEncrypted ?? null,
      notesTitle: record.notesTitle ?? null,
      notesSubtitle: record.notesSubtitle ?? null,
      notesBody: record.notesBody ?? null,
      requestsPerMinute: record.requestsPerMinute ?? null,
      dailyTokenLimit: record.dailyTokenLimit ?? null,
      monthlyTokenLimit: record.monthlyTokenLimit ?? null,
      lifetimeTokenBudget: record.lifetimeTokenBudget ?? null,
      maxConcurrentRequests: record.maxConcurrentRequests ?? null,
      modelPrefix: record.modelPrefix ?? null,
      providerAllowlist: record.providerAllowlist ?? null,
      modelAllowlist: record.modelAllowlist ?? null,
      modelDenylist: record.modelDenylist ?? null,
      lifetimeTokensConsumed: record.tokensConsumed,
    });
  }
  async update(
    tenantId: string,
    keyId: string,
    patch: ApiKeyPatch,
  ): Promise<ApiKeyRecord | undefined> {
    const rows = await this.db
      .update(apiKeys)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
        ...(patch.notesTitle !== undefined ? { notesTitle: patch.notesTitle } : {}),
        ...(patch.notesSubtitle !== undefined ? { notesSubtitle: patch.notesSubtitle } : {}),
        ...(patch.notesBody !== undefined ? { notesBody: patch.notesBody } : {}),
        ...(patch.requestsPerMinute !== undefined
          ? { requestsPerMinute: patch.requestsPerMinute }
          : {}),
        ...(patch.dailyTokenLimit !== undefined ? { dailyTokenLimit: patch.dailyTokenLimit } : {}),
        ...(patch.monthlyTokenLimit !== undefined
          ? { monthlyTokenLimit: patch.monthlyTokenLimit }
          : {}),
        ...(patch.lifetimeTokenBudget !== undefined
          ? { lifetimeTokenBudget: patch.lifetimeTokenBudget }
          : {}),
        ...(patch.maxConcurrentRequests !== undefined
          ? { maxConcurrentRequests: patch.maxConcurrentRequests }
          : {}),
        ...(patch.modelPrefix !== undefined ? { modelPrefix: patch.modelPrefix } : {}),
        ...(patch.providerAllowlist !== undefined
          ? { providerAllowlist: patch.providerAllowlist }
          : {}),
        ...(patch.modelAllowlist !== undefined ? { modelAllowlist: patch.modelAllowlist } : {}),
        ...(patch.modelDenylist !== undefined ? { modelDenylist: patch.modelDenylist } : {}),
      })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
      .returning();
    return rows[0] ? this.map(rows[0]) : undefined;
  }
  async revoke(tenantId: string, keyId: string, revokedAt: Date): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }
  async findActiveByHash(hash: string): Promise<typeof apiKeys.$inferSelect | undefined> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return undefined;
    return row;
  }
}
