// Persisted API-key store: the console API-key domain and gateway authentication both consume this boundary.

import { and, eq, isNull } from "drizzle-orm";
import type { CartethyiaDatabase } from "./postgres";
import { apiKeys, shareLinks, type ApiKeyMode } from "./schema";
import type { AccessScope } from "../security/access-control";

/** Persisted API key. Only its one-way hash authenticates; plaintext is never stored. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string | null;
  readonly keyMode: ApiKeyMode;
  readonly parentKeyId?: string;
  readonly issuedClientIp?: string;
  readonly issuedClientIpKey?: string;
  readonly label: string;
  readonly scopes: readonly AccessScope[];
  /** Non-secret prefix configured on a key or used to identify a share child. */
  readonly keyPrefix?: string;
  /** Encrypted copy exists only for personal keys used by Studio handoff. */
  readonly keyEncrypted?: Buffer;
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
 * Partial key update. Nullable policy fields clear their values; `undefined`
 * leaves them unchanged. Credential metadata is writable only for a mode
 * transition performed by the API-key domain.
 */
export interface ApiKeyPatch
  extends Omit<
    Partial<ApiKeyRecord>,
    | "id"
    | "tenantId"
    | "keyHash"
    | "parentKeyId"
    | "issuedClientIp"
    | "issuedClientIpKey"
    | "createdAt"
    | "revokedAt"
    | "tokensConsumed"
    | "keyEncrypted"
    | "keyPrefix"
    | "notesTitle"
    | "notesSubtitle"
    | "notesBody"
    | "requestsPerMinute"
    | "dailyTokenLimit"
    | "monthlyTokenLimit"
    | "lifetimeTokenBudget"
    | "maxConcurrentRequests"
  > {
  readonly keyHash?: string | null;
  readonly keyEncrypted?: Buffer | null;
  readonly keyPrefix?: string | null;
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
  listChildren(tenantId: string, parentKeyId: string): Promise<readonly ApiKeyRecord[]>;
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
      keyMode: row.keyMode,
      ...(row.parentKeyId === null ? {} : { parentKeyId: row.parentKeyId }),
      ...(row.issuedClientIp === null ? {} : { issuedClientIp: row.issuedClientIp }),
      ...(row.issuedClientIpKey === null
        ? {}
        : { issuedClientIpKey: row.issuedClientIpKey }),
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
  async listChildren(tenantId: string, parentKeyId: string): Promise<readonly ApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, tenantId),
          eq(apiKeys.parentKeyId, parentKeyId),
        ),
      )
      .orderBy(apiKeys.createdAt, apiKeys.id);
    return rows.map((row) => this.map(row));
  }
  async create(record: ApiKeyRecord): Promise<void> {
    await this.db.insert(apiKeys).values({
      id: record.id,
      tenantId: record.tenantId,
      keyHash: record.keyHash,
      keyMode: record.keyMode,
      parentKeyId: record.parentKeyId ?? null,
      issuedClientIp: record.issuedClientIp ?? null,
      issuedClientIpKey: record.issuedClientIpKey ?? null,
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
    return this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select({
          id: apiKeys.id,
          keyMode: apiKeys.keyMode,
          parentKeyId: apiKeys.parentKeyId,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (!existing) return undefined;
      if (existing.parentKeyId !== null && patch.keyMode !== undefined && patch.keyMode !== existing.keyMode)
        return undefined;

      if (existing.keyMode === "share" && patch.keyMode === "personal") {
        await tx
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiKeys.parentKeyId, keyId), isNull(apiKeys.revokedAt)));
        await tx
          .update(shareLinks)
          .set({ active: false })
          .where(and(eq(shareLinks.apiKeyId, keyId), eq(shareLinks.active, true)));
      }

      const rows = await tx
        .update(apiKeys)
        .set({
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
          ...(patch.keyHash !== undefined ? { keyHash: patch.keyHash } : {}),
          ...(patch.keyMode !== undefined ? { keyMode: patch.keyMode } : {}),
          ...(patch.keyEncrypted !== undefined ? { keyEncrypted: patch.keyEncrypted } : {}),
          ...(patch.keyPrefix !== undefined ? { keyPrefix: patch.keyPrefix } : {}),
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
    });
  }
  async revoke(tenantId: string, keyId: string, revokedAt: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(apiKeys)
        .set({ revokedAt })
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            eq(apiKeys.id, keyId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id, keyMode: apiKeys.keyMode, parentKeyId: apiKeys.parentKeyId });
      const row = rows[0];
      if (!row) return false;
      if (row.keyMode === "share" && row.parentKeyId === null) {
        await tx
          .update(apiKeys)
          .set({ revokedAt })
          .where(and(eq(apiKeys.parentKeyId, keyId), isNull(apiKeys.revokedAt)));
        await tx
          .update(shareLinks)
          .set({ active: false })
          .where(and(eq(shareLinks.apiKeyId, keyId), eq(shareLinks.active, true)));
      }
      return true;
    });
  }
  async findActiveByHash(hash: string): Promise<typeof apiKeys.$inferSelect | undefined> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return undefined;
    return row;
  }
}
