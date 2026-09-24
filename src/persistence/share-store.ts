// Share-link persistence: creation for the console owner, lookup for the
// public share routes. Only the SHA-256 hash of the bearer token is stored, so
// a leaked `share_links` row cannot be replayed.

import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
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

/**
 * Console-facing summary of one share link. Carries lifecycle state
 * (`active`/`usedAt`/`lastViewedAt`) so the owner can see which links are
 * still live and revoke the ones that should not be — never the bearer token,
 * which exists only in the response to the create call.
 */
export interface ShareLinkSummary {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly usedAt: Date | null;
  readonly lastViewedAt: Date | null;
}

/** API-key fields authorized for a valid share-link lookup. */
export interface ShareApiKeyRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string | null;
  readonly keyEncrypted: Buffer | null;
  readonly active: boolean;
  readonly rateLimitRpm: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly lifetimeTokenBudget: number | null;
  readonly lifetimeTokensConsumed: number;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: readonly string[] | null;
  readonly modelAllowlist: readonly string[] | null;
  readonly modelDenylist: readonly string[] | null;
  readonly notesTitle: string | null;
  readonly notesSubtitle: string | null;
  readonly notesBody: string | null;
  readonly createdAt: string;
  readonly shareCreatedAt: string;
  readonly expiresAt: string | null;
}

type ApiKeyRow = typeof apiKeys.$inferSelect;
type ShareLinkRow = typeof shareLinks.$inferSelect;

function mapShareRow(key: ApiKeyRow, link: ShareLinkRow): ShareApiKeyRow {
  return {
    id: key.id,
    tenantId: key.tenantId,
    name: key.label,
    keyPrefix: key.keyPrefix,
    keyEncrypted: key.keyEncrypted,
    active: key.revokedAt === null,
    rateLimitRpm: key.requestsPerMinute,
    dailyTokenLimit: key.dailyTokenLimit,
    monthlyTokenLimit: key.monthlyTokenLimit,
    lifetimeTokenBudget: key.lifetimeTokenBudget,
    lifetimeTokensConsumed: key.lifetimeTokensConsumed,
    maxConcurrentRequests: key.maxConcurrentRequests,
    providerAllowlist: key.providerAllowlist,
    modelAllowlist: key.modelAllowlist,
    modelDenylist: key.modelDenylist,
    notesTitle: key.notesTitle,
    notesSubtitle: key.notesSubtitle,
    notesBody: key.notesBody,
    createdAt: key.createdAt.toISOString(),
    shareCreatedAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
  };
}

/** Persistence boundary for share links. */
export interface ShareLinkStore {
  create(input: {
    apiKeyId: string;
    tokenHash: string;
    kind: "monitor" | "setup";
    expiresAt: Date | null;
  }): Promise<ShareLinkRecord>;
  getApiKeyByShareToken(tokenHash: string): Promise<ShareApiKeyRow | null>;
  consumeSetupToken(tokenHash: string): Promise<ShareApiKeyRow | null>;
  touchView(tokenHash: string): Promise<void>;
  /** All share links minted for one API key, newest first (never tokens). */
  listForApiKey(apiKeyId: string): Promise<readonly ShareLinkSummary[]>;
  /**
   * Deactivates one share link. Scoped by both ids so a key can only revoke
   * its own link; returns false when no active link matched.
   */
  revoke(apiKeyId: string, shareId: string): Promise<boolean>;
}

export class DrizzleShareLinkStore implements ShareLinkStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async create(input: {
    apiKeyId: string;
    tokenHash: string;
    kind: "monitor" | "setup";
    expiresAt: Date | null;
  }): Promise<ShareLinkRecord> {
    const rows = await this.db
      .insert(shareLinks)
      .values({
        apiKeyId: input.apiKeyId,
        tokenHash: input.tokenHash,
        kind: input.kind,
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("share link insert returned no row");
    return {
      id: row.id,
      apiKeyId: row.apiKeyId,
      kind: row.kind === "setup" ? "setup" : "monitor",
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
          eq(shareLinks.kind, "monitor"),
          eq(shareLinks.active, true),
          sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapShareRow(row.key, row.link) : null;
  }

  async consumeSetupToken(tokenHash: string): Promise<ShareApiKeyRow | null> {
    // Row lock + conditional update in one transaction: a setup token is
    // consumed exactly once even under concurrent redemption.
    return this.db.transaction(async (tx) => {
      const links = await tx
        .select()
        .from(shareLinks)
        .where(
          and(
            eq(shareLinks.tokenHash, tokenHash),
            eq(shareLinks.kind, "setup"),
            eq(shareLinks.active, true),
            isNull(shareLinks.usedAt),
            sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
          ),
        )
        .limit(1)
        .for("update");
      const link = links[0];
      if (!link) return null;
      const keys = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, link.apiKeyId), isNull(apiKeys.revokedAt)))
        .limit(1);
      const key = keys[0];
      if (!key) return null;
      await tx
        .update(shareLinks)
        .set({ active: false, usedAt: new Date() })
        .where(eq(shareLinks.id, link.id));
      return mapShareRow(key, link);
    });
  }

  async touchView(tokenHash: string): Promise<void> {
    await this.db
      .update(shareLinks)
      .set({ lastViewedAt: new Date() })
      .where(eq(shareLinks.tokenHash, tokenHash));
  }

  async listForApiKey(apiKeyId: string): Promise<readonly ShareLinkSummary[]> {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.apiKeyId, apiKeyId))
      .orderBy(desc(shareLinks.createdAt));
    return rows.map((row) => ({
      id: row.id,
      apiKeyId: row.apiKeyId,
      kind: row.kind === "setup" ? "setup" : "monitor",
      active: row.active,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      lastViewedAt: row.lastViewedAt,
    }));
  }

  async revoke(apiKeyId: string, shareId: string): Promise<boolean> {
    // Soft revoke (not delete): both lookup paths already gate on
    // `active = true`, so flipping the flag disables a monitor link and burns
    // an unspent setup link while keeping the row for audit.
    const rows = await this.db
      .update(shareLinks)
      .set({ active: false })
      .where(
        and(
          eq(shareLinks.id, shareId),
          eq(shareLinks.apiKeyId, apiKeyId),
          eq(shareLinks.active, true),
        ),
      )
      .returning({ id: shareLinks.id });
    return rows.length > 0;
  }
}
