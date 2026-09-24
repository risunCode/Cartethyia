// Public, unauthenticated share routes.
//
// Access is authorized by possession of a high-entropy bearer token whose
// SHA-256 hash is the only thing persisted. Responses are `no-store` and carry
// the locked-down API CSP so a share document can never be cached or framed.

import { Elysia } from "elysia";
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { models, providers } from "../../persistence/schema";
import {
  hashShareToken,
  type ShareApiKeyRow,
  type ShareLinkStore,
} from "../../persistence/share-store";
import { decryptCredentialToString } from "../../security/crypto";
import { isModelAllowed, isProviderAllowed, type ApiKeyAuthorizationSnapshot } from "../../security/api-key-auth";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "../../security/outbound-headers";
import { createShareUsagePort, type ShareUsagePort } from "./share-usage";

/** Minimum accepted token length; generated tokens are 43 base64url chars. */
const MIN_TOKEN_LENGTH = 20;

export interface ShareRouterOptions {
  readonly db: CartethyiaDatabase;
  readonly shareStore: ShareLinkStore;
  /** Telemetry reader; defaults to the Drizzle-backed implementation. */
  readonly usage?: ShareUsagePort;
}

function shareHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": API_CONTENT_SECURITY_POLICY,
    "x-frame-options": X_FRAME_OPTIONS,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: shareHeaders() });
}

function notFound(): Response {
  return json({ error: { code: "link_not_found", message: "Share not found" } }, 404);
}

/** Decrypts the stored key copy; null for keys predating share-secret storage. */
function decryptSharedKey(row: ShareApiKeyRow): string | null {
  if (row.keyEncrypted === null) return null;
  try {
    return decryptCredentialToString(row.keyEncrypted);
  } catch {
    return null;
  }
}

function providerOf(slug: string): string {
  const index = slug.indexOf("/");
  return index === -1 ? "" : slug.slice(0, index);
}

/**
 * Resolves the models a share recipient may use.
 *
 * A configured allowlist is authoritative and returned verbatim (minus denied
 * entries) so a partially synced catalog can never silently widen access. Only
 * an unrestricted key falls back to enumerating the enabled catalog.
 */
async function modelsForShare(db: CartethyiaDatabase, row: ShareApiKeyRow): Promise<string[]> {
  const snapshot: ApiKeyAuthorizationSnapshot = {
    api_key_id: row.id,
    tenant_id: row.tenantId,
    provider_allowlist: row.providerAllowlist,
    model_allowlist: row.modelAllowlist,
    model_denylist: row.modelDenylist,
  };
  const denied = new Set(row.modelDenylist ?? []);
  const configured = row.modelAllowlist;
  if (configured !== null && configured.length > 0) {
    return configured
      .filter((slug) => isProviderAllowed(snapshot, providerOf(slug)))
      .filter((slug) => !denied.has(slug))
      .sort((left, right) => left.localeCompare(right));
  }
  const providerScope =
    row.tenantId === null
      ? isNull(providers.tenantId)
      : or(isNull(providers.tenantId), eq(providers.tenantId, row.tenantId));
  const rows = await db
    .select({ providerId: models.providerId, modelId: models.modelId })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.enabled, true), providerScope));
  const slugs = new Set<string>();
  for (const entry of rows) {
    if (!isProviderAllowed(snapshot, entry.providerId)) continue;
    const slug = `${entry.providerId}/${entry.modelId}`;
    if (!isModelAllowed(snapshot, slug) && !isModelAllowed(snapshot, entry.modelId)) continue;
    if (denied.has(slug)) continue;
    slugs.add(slug);
  }
  return [...slugs].sort((left, right) => left.localeCompare(right));
}

function remaining(limit: number | null, used: number): number | null {
  return limit === null ? null : Math.max(0, limit - used);
}

/** Creates the public monitor and one-time setup share routes. */
export function createShareRouter(options: ShareRouterOptions): Elysia {
  const { db, shareStore } = options;
  const usage = options.usage ?? createShareUsagePort(db);

  return new Elysia()
    .get("/share/:token/data", async ({ params }) => {
      const token = (params as { token: string }).token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const row = await shareStore.getApiKeyByShareToken(hashShareToken(token));
      if (row === null) return notFound();

      const [modelAllowlist, totals] = await Promise.all([
        modelsForShare(db, row),
        usage.getApiKeyTotals(row.id),
      ]);
      void shareStore.touchView(hashShareToken(token)).catch(() => undefined);

      const dailyUsed = totals.dailyTokens;
      const monthlyUsed = totals.monthlyTokens;
      const oneTimeUsed = row.lifetimeTokensConsumed;
      return json({
        name: row.name,
        active: row.active,
        apiKey: {
          id: row.id,
          prefix: row.keyPrefix,
          key: decryptSharedKey(row),
          active: row.active,
        },
        quotaAvailable: true,
        dailyUsed,
        dailyLimit: row.dailyTokenLimit,
        dailyRemaining: remaining(row.dailyTokenLimit, dailyUsed),
        monthlyUsed,
        monthlyLimit: row.monthlyTokenLimit,
        monthlyRemaining: remaining(row.monthlyTokenLimit, monthlyUsed),
        oneTimeLimit: row.lifetimeTokenBudget,
        oneTimeUsed,
        oneTimeRemaining: remaining(row.lifetimeTokenBudget, oneTimeUsed),
        rateLimitRpm: row.rateLimitRpm,
        maxConcurrentRequests: row.maxConcurrentRequests,
        providerAllowlist: row.providerAllowlist,
        modelAllowlist,
        modelDenylist: row.modelDenylist,
        notes: {
          title: row.notesTitle,
          subtitle: row.notesSubtitle,
          body: row.notesBody,
        },
        createdAt: row.shareCreatedAt,
        lastUsedAt: totals.lastUsedAt,
        totalTokens: totals.totalTokens,
        totalRequests: totals.totalRequests,
        successCount: totals.successCount,
        errorCount: totals.errorCount,
      });
    })
    .get("/share/setup/:token/data", async ({ params }) => {
      const token = (params as { token: string }).token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const row = await shareStore.consumeSetupToken(hashShareToken(token));
      if (row === null) return notFound();
      return json({
        name: row.name,
        key: decryptSharedKey(row),
        expiresAt: row.expiresAt,
      });
    }) as unknown as Elysia;
}
