// Persisted API-key store: the console API-key domain and gateway authentication both consume this boundary.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./postgres";
import { apiKeys, shareLinks, type ApiKeyMode, type ApiKeyModelAccessMode } from "./schema";
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
  readonly enabled: boolean;
  readonly scopes: readonly AccessScope[];
  /** Non-secret prefix configured on a key or used to identify a share child. */
  readonly keyPrefix?: string;
  /** Encrypted copy exists only for personal keys used by Studio handoff. */
  readonly keyEncrypted?: Buffer;
  readonly notesTitle?: string;
  readonly notesSubtitle?: string;
  readonly notesBody?: string;
  readonly sharePopupEnabled?: boolean;
  /** Uploaded popup art; served from the share page rather than a remote URL. */
  readonly sharePopupImage?: Buffer;
  readonly sharePopupImageMime?: string;
  readonly sharePopupTitle?: string;
  readonly sharePopupBody?: string;
  readonly requestsPerMinute?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly lifetimeTokenBudget?: number;
  readonly maxConcurrentRequests?: number;
  readonly modelPrefix?: string;
  readonly modelAccessMode?: ApiKeyModelAccessMode;
  readonly modelList?: readonly string[];
  /** Client-router ids this key refuses; see the schema column for the contract. */
  readonly clientRouterDenylist?: readonly string[];
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
    | "sharePopupEnabled"
    | "sharePopupImage"
    | "sharePopupImageMime"
    | "sharePopupTitle"
    | "sharePopupBody"
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
  readonly sharePopupEnabled?: boolean | null;
  /** Null clears both bytes and mime; setting one without the other is rejected upstream. */
  readonly sharePopupImage?: Buffer | null;
  readonly sharePopupImageMime?: string | null;
  readonly sharePopupTitle?: string | null;
  readonly sharePopupBody?: string | null;
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
  /** Rewrites list order for one tenant; `keyIds` is the full desired order. */
  reorder(tenantId: string, keyIds: readonly string[]): Promise<void>;
  update(tenantId: string, keyId: string, patch: ApiKeyPatch): Promise<ApiKeyRecord | undefined>;
  revoke(tenantId: string, keyId: string, revokedAt: Date): Promise<boolean>;
  findActiveByHash?(hash: string): Promise<typeof apiKeys.$inferSelect | undefined>;
  findActiveById?(keyId: string): Promise<typeof apiKeys.$inferSelect | undefined>;
  sumChildrenConsumed?(parentKeyId: string): Promise<number>;
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
      enabled: row.enabled,
      scopes: row.scopes as ApiKeyRecord["scopes"],
      ...(row.keyPrefix === null ? {} : { keyPrefix: row.keyPrefix }),
      ...(row.keyEncrypted === null ? {} : { keyEncrypted: row.keyEncrypted }),
      ...(row.notesTitle === null ? {} : { notesTitle: row.notesTitle }),
      ...(row.notesSubtitle === null ? {} : { notesSubtitle: row.notesSubtitle }),
      ...(row.notesBody === null ? {} : { notesBody: row.notesBody }),
      ...(row.sharePopupEnabled ? { sharePopupEnabled: row.sharePopupEnabled } : {}),
      ...(row.sharePopupImage === null ? {} : { sharePopupImage: row.sharePopupImage }),
      ...(row.sharePopupImageMime === null ? {} : { sharePopupImageMime: row.sharePopupImageMime }),
      ...(row.sharePopupTitle === null ? {} : { sharePopupTitle: row.sharePopupTitle }),
      ...(row.sharePopupBody === null ? {} : { sharePopupBody: row.sharePopupBody }),
      ...(row.requestsPerMinute === null ? {} : { requestsPerMinute: row.requestsPerMinute }),
      ...(row.dailyTokenLimit === null ? {} : { dailyTokenLimit: row.dailyTokenLimit }),
      ...(row.monthlyTokenLimit === null ? {} : { monthlyTokenLimit: row.monthlyTokenLimit }),
      ...(row.lifetimeTokenBudget === null ? {} : { lifetimeTokenBudget: row.lifetimeTokenBudget }),
      ...(row.maxConcurrentRequests === null
        ? {}
        : { maxConcurrentRequests: row.maxConcurrentRequests }),
      ...(row.modelPrefix === null ? {} : { modelPrefix: row.modelPrefix }),
      modelAccessMode: row.modelAccessMode,
      ...(row.modelList === null ? {} : { modelList: row.modelList as string[] }),
      ...(row.clientRouterDenylist === null
        ? {}
        : { clientRouterDenylist: row.clientRouterDenylist as string[] }),
      createdAt: row.createdAt,
      ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
      tokensConsumed: row.lifetimeTokensConsumed,
    };
  }
  async list(tenantId: string): Promise<readonly ApiKeyRecord[]> {
    // Bounded: a large tenant key list must not load fully into memory.
    // Ordered by the explicit `sort_index`, not `created_at`: a stable key means
    // rows keep their position across reloads (and can be reordered) instead of
    // shifting when two rows share a timestamp or one is updated.
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId))
      .orderBy(apiKeys.sortIndex, apiKeys.createdAt, apiKeys.id)
      .limit(1000);
    return rows.map((row) => this.map(row));
  }

  /** Rewrites the list order for one tenant; `keyIds` is the full order. */
  async reorder(tenantId: string, keyIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [index, keyId] of keyIds.entries()) {
        await tx
          .update(apiKeys)
          .set({ sortIndex: index })
          .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)));
      }
    });
  }

  /** Next free list position for a new key in this tenant. */
  private async nextSortIndex(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({ max: sql<number>`coalesce(max(${apiKeys.sortIndex}), -1)` })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId));
    return Number(rows[0]?.max ?? -1) + 1;
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
    // Append to the end of the tenant's list rather than relying on creation
    // time, so a new key never displaces the existing rows' positions.
    const sortIndex = await this.nextSortIndex(record.tenantId);
    await this.db.insert(apiKeys).values({
      id: record.id,
      tenantId: record.tenantId,
      sortIndex,
      keyHash: record.keyHash,
      keyMode: record.keyMode,
      parentKeyId: record.parentKeyId ?? null,
      issuedClientIp: record.issuedClientIp ?? null,
      issuedClientIpKey: record.issuedClientIpKey ?? null,
      label: record.label,
      scopes: record.scopes,
      enabled: record.enabled,
      keyPrefix: record.keyPrefix ?? null,
      keyEncrypted: record.keyEncrypted ?? null,
      notesTitle: record.notesTitle ?? null,
      notesSubtitle: record.notesSubtitle ?? null,
      notesBody: record.notesBody ?? null,
      sharePopupEnabled: record.sharePopupEnabled ?? false,
      sharePopupImage: record.sharePopupImage ?? null,
      sharePopupImageMime: record.sharePopupImageMime ?? null,
      sharePopupTitle: record.sharePopupTitle ?? null,
      sharePopupBody: record.sharePopupBody ?? null,
      requestsPerMinute: record.requestsPerMinute ?? null,
      dailyTokenLimit: record.dailyTokenLimit ?? null,
      monthlyTokenLimit: record.monthlyTokenLimit ?? null,
      lifetimeTokenBudget: record.lifetimeTokenBudget ?? null,
      maxConcurrentRequests: record.maxConcurrentRequests ?? null,
      modelPrefix: record.modelPrefix ?? null,
      modelAccessMode: record.modelAccessMode ?? "whitelist",
      modelList: record.modelList ?? null,
      clientRouterDenylist: record.clientRouterDenylist ?? null,
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
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
          ...(patch.keyHash !== undefined ? { keyHash: patch.keyHash } : {}),
          ...(patch.keyMode !== undefined ? { keyMode: patch.keyMode } : {}),
          ...(patch.keyEncrypted !== undefined ? { keyEncrypted: patch.keyEncrypted } : {}),
          ...(patch.keyPrefix !== undefined ? { keyPrefix: patch.keyPrefix } : {}),
          ...(patch.notesTitle !== undefined ? { notesTitle: patch.notesTitle } : {}),
          ...(patch.notesSubtitle !== undefined ? { notesSubtitle: patch.notesSubtitle } : {}),
          ...(patch.notesBody !== undefined ? { notesBody: patch.notesBody } : {}),
          ...(patch.sharePopupEnabled !== undefined ? { sharePopupEnabled: patch.sharePopupEnabled ?? false } : {}),
          ...(patch.sharePopupImage !== undefined
            ? { sharePopupImage: patch.sharePopupImage }
            : {}),
          ...(patch.sharePopupImageMime !== undefined
            ? { sharePopupImageMime: patch.sharePopupImageMime }
            : {}),
          ...(patch.sharePopupTitle !== undefined ? { sharePopupTitle: patch.sharePopupTitle } : {}),
          ...(patch.sharePopupBody !== undefined ? { sharePopupBody: patch.sharePopupBody } : {}),
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
          ...(patch.modelAccessMode !== undefined ? { modelAccessMode: patch.modelAccessMode } : {}),
          ...(patch.modelList !== undefined ? { modelList: patch.modelList } : {}),
          ...(patch.clientRouterDenylist !== undefined
            ? { clientRouterDenylist: patch.clientRouterDenylist }
            : {}),
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
    // Filter revoked in the DB, not in JS: the hot auth path must not fetch
    // revoked rows it immediately discards.
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.enabled, true), isNull(apiKeys.revokedAt)))
      .limit(1);
    return rows[0];
  }

  async findActiveById(keyId: string): Promise<typeof apiKeys.$inferSelect | undefined> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.enabled, true), isNull(apiKeys.revokedAt)))
      .limit(1);
    return rows[0];
  }

  /**
   * Total lifetime consumption across one key's children, revoked included.
   *
   * The parent's own counter never moves for child traffic — attribution
   * lands on the child row — so quota enforcement reads the parent plus this
   * sum rather than the parent alone.
   *
   * Revoked children stay in the sum on purpose. Tokens a recipient already
   * spent are spent; dropping them on revoke would refund the parent's budget
   * the moment the Redis lifetime counter is re-seeded from this total (which
   * happens on every purge, and whenever that counter's TTL lapses), letting a
   * recipient burn the whole allowance, be revoked, and hand the next
   * recipient a fresh one. It also keeps this figure equal to the "Total
   * quota" the share dialog reports, which counts every recipient.
   */
  async sumChildrenConsumed(parentKeyId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${apiKeys.lifetimeTokensConsumed}), 0)` })
      .from(apiKeys)
      .where(eq(apiKeys.parentKeyId, parentKeyId));
    return Number(rows[0]?.total ?? 0);
  }
}
