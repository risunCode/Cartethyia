import { createHash, randomInt } from "node:crypto";

// Share-link persistence and atomic child-key issuance. The hash is the lookup
// key; the bearer token is retained encrypted so the console can re-display a
// stable link, and is never selected by a public lookup.

import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./postgres";
import { apiKeys, shareLinks, type ShareLinkKind, type ApiKeyModelAccessMode } from "./schema";

/** Hashes a share bearer token for storage and lookup. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Newly created share-link metadata. */
export interface ShareLinkRecord {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * Console-facing view of one link. The caller supplies the decrypted token;
 * this record itself never reads the token column.
 */
export interface ShareLinkSummary {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastViewedAt: Date | null;
}

/** A stable link's encrypted token, or null when it predates token retention. */
export interface ShareLinkToken {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly expiresAt: Date | null;
  readonly tokenEncrypted: Buffer | null;
}

/**
 * Policy fields a share recipient sees, whichever kind of link carried them.
 * Both resolutions project the same columns, so the public payload and the
 * model filter read one shape instead of two near-identical ones.
 */
export interface ShareLinkPolicy {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string | null;
  readonly requestsPerMinute: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly lifetimeTokenBudget: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly modelAccessMode: ApiKeyModelAccessMode | null;
  readonly modelList: readonly string[] | null;
  readonly modelPrefix: string | null;
  readonly notesTitle: string | null;
  readonly notesSubtitle: string | null;
  readonly notesBody: string | null;
  readonly sharePopupEnabled: boolean;
  /** Uploaded popup art; the share page fetches it from its own image route. */
  readonly sharePopupImage: Buffer | null;
  readonly sharePopupImageMime: string | null;
  readonly sharePopupTitle: string | null;
  readonly sharePopupBody: string | null;
  readonly expiresAt: string | null;
}

/** Public template fields authorized for a valid enrollment-link lookup. */
export interface ShareApiKeyRow extends ShareLinkPolicy {
  readonly active: boolean;
  readonly createdAt: string;
}

/** A personal key revealed by its handoff link. */
export interface ShareHandoffRow extends ShareLinkPolicy {
  /** Encrypted personal credential; null when the row predates secret storage. */
  readonly keyEncrypted: Buffer | null;
}

/**
 * What one bearer token resolves to. A link is exactly one of these, so a
 * public lookup answers with a discriminated result instead of the caller
 * guessing which endpoint to try.
 */
export type ShareLinkResolution =
  | { readonly kind: "enroll"; readonly key: ShareApiKeyRow }
  | { readonly kind: "handoff"; readonly key: ShareHandoffRow };

/**
 * Why a share link stopped resolving.
 *
 * A paused key (`disabled`) is not a revoked one and not an expired link, but
 * the resolver answered `null` for all three, so the page could only say
 * "link unavailable" — which tells an operator nothing about whether to
 * regenerate the link, re-enable the key, or issue a new one.
 */
export type ShareLinkRefusal = "not_found" | "expired" | "revoked" | "disabled";

export type ShareLinkOutcome =
  | { readonly ok: true; readonly resolution: ShareLinkResolution }
  | { readonly ok: false; readonly refusal: ShareLinkRefusal };

export interface SharedApiKeyMaterial {
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly clientIp: string;
  readonly clientIpKey: string;
  /** Recipient-supplied name hint; the store composes the final label from it. */
  readonly nameHint?: string;
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
    modelAccessMode: key.modelAccessMode as ApiKeyModelAccessMode | null,
    modelList: key.modelList as readonly string[] | null,
    modelPrefix: key.modelPrefix,
    notesTitle: key.notesTitle,
    notesSubtitle: key.notesSubtitle,
    notesBody: key.notesBody,
    sharePopupEnabled: key.sharePopupEnabled,
    sharePopupImage: key.sharePopupImage,
    sharePopupImageMime: key.sharePopupImageMime,
    sharePopupTitle: key.sharePopupTitle,
    sharePopupBody: key.sharePopupBody,
    createdAt: key.createdAt.toISOString(),
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
}

function mapHandoffRow(key: ApiKeyRow, link: ShareLinkRow): ShareHandoffRow {
  return {
    id: key.id,
    tenantId: key.tenantId,
    name: key.label,
    keyPrefix: key.keyPrefix,
    keyEncrypted: key.keyEncrypted,
    requestsPerMinute: key.requestsPerMinute,
    dailyTokenLimit: key.dailyTokenLimit,
    monthlyTokenLimit: key.monthlyTokenLimit,
    lifetimeTokenBudget: key.lifetimeTokenBudget,
    maxConcurrentRequests: key.maxConcurrentRequests,
    modelAccessMode: key.modelAccessMode as ApiKeyModelAccessMode | null,
    modelList: key.modelList as readonly string[] | null,
    modelPrefix: key.modelPrefix,
    notesTitle: key.notesTitle,
    notesSubtitle: key.notesSubtitle,
    notesBody: key.notesBody,
    sharePopupEnabled: key.sharePopupEnabled,
    sharePopupImage: key.sharePopupImage,
    sharePopupImageMime: key.sharePopupImageMime,
    sharePopupTitle: key.sharePopupTitle,
    sharePopupBody: key.sharePopupBody,
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
  /**
   * Establishes the key's single link, or rotates it in place.
   *
   * One active link per key is the contract: calling this again replaces the
   * token so the previous URL stops resolving. `rotate` false returns the
   * existing link untouched.
   */
  create(input: {
    apiKeyId: string;
    tokenHash: string;
    tokenEncrypted: Buffer;
    kind: ShareLinkKind;
    expiresAt: Date | null;
    rotate: boolean;
  }): Promise<ShareLinkRecord>;
  /**
   * Resolves a bearer token to the link it names, in one lookup.
   *
   * Serving enrollment and handoff through separate methods let the browser
   * page and the router disagree about which one a given URL is: a personal
   * key's handoff link resolved on one endpoint and 404'd on the other. One
   * resolver cannot drift from itself.
   */
  resolveShareLink(tokenHash: string): Promise<ShareLinkResolution | null>;
  /** Same lookup as `resolveShareLink`, but names why a link stopped resolving. */
  resolveShareLinkOutcome(tokenHash: string): Promise<ShareLinkOutcome>;
  /** The key's active link with its retained token, for console re-display. */
  findTokenForApiKey(apiKeyId: string): Promise<ShareLinkToken | null>;
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
    tokenEncrypted: Buffer;
    kind: ShareLinkKind;
    expiresAt: Date | null;
    rotate: boolean;
  }): Promise<ShareLinkRecord> {
    return await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(shareLinks)
        .where(and(eq(shareLinks.apiKeyId, input.apiKeyId), eq(shareLinks.active, true)))
        .orderBy(desc(shareLinks.createdAt))
        .limit(1)
        .for("update");
      const current = existing[0];
      if (current && !input.rotate) {
        return {
          id: current.id,
          apiKeyId: current.apiKeyId,
          kind: current.kind,
          createdAt: current.createdAt,
          expiresAt: current.expiresAt,
        };
      }
      if (current) {
        const updated = await tx
          .update(shareLinks)
          .set({
            tokenHash: input.tokenHash,
            tokenEncrypted: input.tokenEncrypted,
            expiresAt: input.expiresAt,
            lastViewedAt: null,
          })
          .where(eq(shareLinks.id, current.id))
          .returning();
        const row = updated[0];
        if (!row) throw new Error("share link rotate returned no row");
        return {
          id: row.id,
          apiKeyId: row.apiKeyId,
          kind: row.kind,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        };
      }
      const rows = await tx
        .insert(shareLinks)
        .values({
          apiKeyId: input.apiKeyId,
          tokenHash: input.tokenHash,
          tokenEncrypted: input.tokenEncrypted,
          kind: input.kind,
          expiresAt: input.expiresAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("share link insert returned no row");
      return {
        id: row.id,
        apiKeyId: row.apiKeyId,
        kind: row.kind,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
    });
  }

  async resolveShareLink(tokenHash: string): Promise<ShareLinkResolution | null> {
    const outcome = await this.resolveShareLinkOutcome(tokenHash);
    return outcome.ok ? outcome.resolution : null;
  }

  /**
   * Same lookup as {@link resolveShareLink}, but reports *why* a link stopped
   * resolving instead of collapsing every cause into `null`. The refusal is
   * decided from the row that actually exists: dropping the health predicates
   * from the `WHERE` and classifying afterwards is the only way to tell an
   * expired link from a revoked key from a paused one, since a row failing any
   * of them is simply absent from the filtered result.
   */
  async resolveShareLinkOutcome(tokenHash: string): Promise<ShareLinkOutcome> {
    const rows = await this.db
      .select({ key: apiKeys, link: shareLinks })
      .from(shareLinks)
      .innerJoin(apiKeys, eq(shareLinks.apiKeyId, apiKeys.id))
      .where(and(eq(shareLinks.tokenHash, tokenHash), isNull(apiKeys.parentKeyId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { ok: false, refusal: "not_found" };
    // Ordering: a deactivated link was revoked by its owner, not expired —
    // "expired" would send them to regenerate a link they deliberately killed.
    // Beyond that, report the state the operator can actually change: a key
    // can be both paused and expired, and either way the link needs
    // regenerating, so the key's own state is the more actionable answer.
    if (row.link.active !== true) return { ok: false, refusal: "revoked" };
    if (row.key.revokedAt !== null) return { ok: false, refusal: "revoked" };
    if (row.key.enabled !== true) return { ok: false, refusal: "disabled" };
    if (row.link.expiresAt !== null && row.link.expiresAt.getTime() <= Date.now())
      return { ok: false, refusal: "expired" };
    // The link's kind and the key's mode must agree: an enrollment link hands
    // out child keys from a share template, which has no credential of its own
    // to reveal, while a handoff link reveals a personal key. A row where the
    // two disagree is a mismatched pair, not a link to serve.
    if (row.link.kind === "enroll") {
      return row.key.keyMode === "share"
        ? { ok: true, resolution: { kind: "enroll", key: mapShareRow(row.key, row.link) } }
        : { ok: false, refusal: "not_found" };
    }
    return row.key.keyMode === "personal"
      ? { ok: true, resolution: { kind: "handoff", key: mapHandoffRow(row.key, row.link) } }
      : { ok: false, refusal: "not_found" };
  }

  async findTokenForApiKey(apiKeyId: string): Promise<ShareLinkToken | null> {
    const rows = await this.db
      .select({
        id: shareLinks.id,
        apiKeyId: shareLinks.apiKeyId,
        kind: shareLinks.kind,
        expiresAt: shareLinks.expiresAt,
        tokenEncrypted: shareLinks.tokenEncrypted,
      })
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.apiKeyId, apiKeyId),
          eq(shareLinks.active, true),
          sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
        ),
      )
      .orderBy(desc(shareLinks.createdAt))
      .limit(1);
    return rows[0] ?? null;
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

        // The label is `hint + random`, capped at 12 chars — never the
        // parent's full label plus a suffix, which grew past every table
        // column it rendered in. Built here (not imported from the console
        // domain) because persistence never imports console code.
        const hint = (material.nameHint ?? "").trim().slice(0, 7);
        const suffix = randomInt(1000, 10_000).toString();
        const label =
          hint.length === 0 ? `key-${suffix}` : `${hint}-${suffix}`.slice(0, 12);
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
            modelAccessMode: parent.modelAccessMode,
            modelList: parent.modelList,
            clientRouterDenylist: parent.clientRouterDenylist,
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
    // Expired-but-active links must not bump lastViewedAt: the bump makes
    // expiry auditing lie about a link that no longer serves.
    await this.db
      .update(shareLinks)
      .set({ lastViewedAt: new Date() })
      .where(
        and(
          eq(shareLinks.tokenHash, tokenHash),
          eq(shareLinks.active, true),
          sql`${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > NOW()`,
        ),
      );
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
