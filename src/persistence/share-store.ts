import { createHash } from "node:crypto";

// Share-link persistence and atomic child-key issuance. Only bearer token hashes are stored.

import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./postgres";
import { apiKeys, shareLinks, type ShareLinkKind } from "./schema";

/** Hashes a share bearer token for storage and lookup. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Newly created share-link metadata (never the bearer token). */
export interface ShareLinkRecord {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/** Console-facing summary of an enrollment link; never includes its token. */
export interface ShareLinkSummary {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastViewedAt: Date | null;
}

/** Public template fields authorized for a valid enrollment-link lookup. */
export interface ShareApiKeyRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string | null;
  readonly active: boolean;
  readonly requestsPerMinute: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly lifetimeTokenBudget: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: readonly string[] | null;
  readonly modelAllowlist: readonly string[] | null;
  readonly modelDenylist: readonly string[] | null;
  readonly modelPrefix: string | null;
  readonly notesTitle: string | null;
  readonly notesSubtitle: string | null;
  readonly notesBody: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface SharedApiKeyMaterial {
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly clientIp: string;
  readonly clientIpKey: string;
}

export type SharedApiKeyIssueResult =
  | {
      readonly kind: "issued";
      readonly apiKeyId: string;
      readonly parentKeyId: string;
      readonly tenantId: string;
      readonly label: string;
      readonly keyPrefix: string;
      readonly createdAt: Date;
    }
  | { readonly kind: "link_unavailable" }
  | { readonly kind: "ip_limit" };

type ApiKeyRow = typeof apiKeys.$inferSelect;
type ShareLinkRow = typeof shareLinks.$inferSelect;

function mapShareRow(key: ApiKeyRow, link: ShareLinkRow): ShareApiKeyRow {
  return {
    id: key.id,
    tenantId: key.tenantId,
    name: key.label,
    keyPrefix: key.keyPrefix,
    active: key.revokedAt === null,
    requestsPerMinute: key.requestsPerMinute,
    dailyTokenLimit: key.dailyTokenLimit,
    monthlyTokenLimit: key.monthlyTokenLimit,
    lifetimeTokenBudget: key.lifetimeTokenBudget,
    maxConcurrentRequests: key.maxConcurrentRequests,
    providerAllowlist: key.providerAllowlist as readonly string[] | null,
    modelAllowlist: key.modelAllowlist as readonly string[] | null,
    modelDenylist: key.modelDenylist as readonly string[] | null,
    modelPrefix: key.modelPrefix,
    notesTitle: key.notesTitle,
    notesSubtitle: key.notesSubtitle,
    notesBody: key.notesBody,
    createdAt: key.createdAt.toISOString(),
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
}

function uniqueConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if (
      "code" in current && current.code === "23505" &&
      "constraint" in current && typeof current.constraint === "string"
    ) {
      return current.constraint;
    }
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

/** Persistence boundary for public enrollment links and child API keys. */
export interface ShareLinkStore {
  create(input: {
    apiKeyId: string;
    tokenHash: string;
    expiresAt: Date | null;
  }): Promise<ShareLinkRecord>;
  getApiKeyByShareToken(tokenHash: string): Promise<ShareApiKeyRow | null>;
  hasActiveSharedKeyForIp(clientIpKey: string): Promise<boolean>;
  issueSharedApiKey(
    tokenHash: string,
    material: SharedApiKeyMaterial,
  ): Promise<SharedApiKeyIssueResult>;
  touchView(tokenHash: string): Promise<void>;
  /** All enrollment links for one API key, newest first (never tokens). */
  listForApiKey(apiKeyId: string): Promise<readonly ShareLinkSummary[]>;
  /** Deactivates one enrollment link scoped to its owning parent API key. */
  revoke(apiKeyId: string, shareId: string): Promise<boolean>;
}

/** SQLSTATE/constraint extraction is local so only the IP uniqueness violation becomes a conflict. */
export class DrizzleShareLinkStore implements ShareLinkStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async create(input: {
    apiKeyId: string;
    tokenHash: string;
    expiresAt: Date | null;
  }): Promise<ShareLinkRecord> {
    const rows = await this.db
      .insert(shareLinks)
      .values({
        apiKeyId: input.apiKeyId,
        tokenHash: input.tokenHash,
        kind: "enroll",
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("share link insert returned no row");
    return {
      id: row.id,
      apiKeyId: row.apiKeyId,
      kind: "enroll",
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  async getApiKeyByShareToken(tokenHash: string): Promise<ShareApiKeyRow | null> {
    const rows = await this.db
      .select({ key: apiKeys, link: shareLinks })
      .from(shareLinks)
      .innerJoin(apiKeys, eq(shareLinks.apiKeyId, apiKeys.id))
      .where(
        and(
          eq(shareLinks.tokenHash, tokenHash),
          eq(shareLinks.kind, "enroll"),
          eq(shareLinks.active, true),
          sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
          isNull(apiKeys.revokedAt),
          eq(apiKeys.keyMode, "share"),
          isNull(apiKeys.parentKeyId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapShareRow(row.key, row.link) : null;
  }

  async hasActiveSharedKeyForIp(clientIpKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.issuedClientIpKey, clientIpKey),
          isNotNull(apiKeys.parentKeyId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async issueSharedApiKey(
    tokenHash: string,
    material: SharedApiKeyMaterial,
  ): Promise<SharedApiKeyIssueResult> {
    try {
      return await this.db.transaction(async (tx) => {
        // Read the link first without locking, then lock its parent before the
        // link. Parent revocation uses the same lock order and is atomic with
        // child revocation, so a concurrent issue cannot escape the parent.
        const [linkRef] = await tx
          .select({ id: shareLinks.id, apiKeyId: shareLinks.apiKeyId })
          .from(shareLinks)
          .where(
            and(
              eq(shareLinks.tokenHash, tokenHash),
              eq(shareLinks.kind, "enroll"),
              eq(shareLinks.active, true),
              sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
            ),
          )
          .limit(1);
        if (!linkRef) return { kind: "link_unavailable" };

        const [parent] = await tx
          .select()
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, linkRef.apiKeyId),
              eq(apiKeys.keyMode, "share"),
              isNull(apiKeys.parentKeyId),
              isNull(apiKeys.revokedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!parent) return { kind: "link_unavailable" };

        const [activeLink] = await tx
          .select({ id: shareLinks.id })
          .from(shareLinks)
          .where(
            and(
              eq(shareLinks.id, linkRef.id),
              eq(shareLinks.tokenHash, tokenHash),
              eq(shareLinks.active, true),
              sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
            ),
          )
          .limit(1)
          .for("update");
        if (!activeLink) return { kind: "link_unavailable" };

        const label = `${parent.label} shared key`;
        const [child] = await tx
          .insert(apiKeys)
          .values({
            tenantId: parent.tenantId,
            keyHash: material.keyHash,
            keyMode: "share",
            parentKeyId: parent.id,
            issuedClientIp: material.clientIp,
            issuedClientIpKey: material.clientIpKey,
            label,
            scopes: parent.scopes,
            keyPrefix: material.keyPrefix,
            keyEncrypted: null,
            notesTitle: parent.notesTitle,
            notesSubtitle: parent.notesSubtitle,
            notesBody: parent.notesBody,
            requestsPerMinute: parent.requestsPerMinute,
            dailyTokenLimit: parent.dailyTokenLimit,
            monthlyTokenLimit: parent.monthlyTokenLimit,
            lifetimeTokenBudget: parent.lifetimeTokenBudget,
            maxConcurrentRequests: parent.maxConcurrentRequests,
            modelPrefix: parent.modelPrefix,
            providerAllowlist: parent.providerAllowlist,
            modelAllowlist: parent.modelAllowlist,
            modelDenylist: parent.modelDenylist,
            lifetimeTokensConsumed: 0,
          })
          .returning({ id: apiKeys.id, tenantId: apiKeys.tenantId, createdAt: apiKeys.createdAt });
        if (!child) throw new Error("shared API-key insert returned no row");
        return {
          kind: "issued",
          apiKeyId: child.id,
          parentKeyId: parent.id,
          tenantId: child.tenantId,
          label,
          keyPrefix: material.keyPrefix,
          createdAt: child.createdAt,
        };
      });
    } catch (error) {
      if (uniqueConstraint(error) === "api_keys_active_shared_ip_uidx")
        return { kind: "ip_limit" };
      throw error;
    }
  }

  async touchView(tokenHash: string): Promise<void> {
    await this.db
      .update(shareLinks)
      .set({ lastViewedAt: new Date() })
      .where(and(eq(shareLinks.tokenHash, tokenHash), eq(shareLinks.active, true)));
  }

  async listForApiKey(apiKeyId: string): Promise<readonly ShareLinkSummary[]> {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.apiKeyId, apiKeyId), eq(shareLinks.kind, "enroll")))
      .orderBy(desc(shareLinks.createdAt));
    return rows.map((row) => ({
      id: row.id,
      apiKeyId: row.apiKeyId,
      kind: "enroll",
      active: row.active,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastViewedAt: row.lastViewedAt,
    }));
  }

  async revoke(apiKeyId: string, shareId: string): Promise<boolean> {
    const rows = await this.db
      .update(shareLinks)
      .set({ active: false })
      .where(
        and(
          eq(shareLinks.id, shareId),
          eq(shareLinks.apiKeyId, apiKeyId),
          eq(shareLinks.kind, "enroll"),
          eq(shareLinks.active, true),
        ),
      )
      .returning({ id: shareLinks.id });
    return rows.length > 0;
  }
}
