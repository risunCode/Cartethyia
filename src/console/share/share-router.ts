// Public enrollment routes for shared API-key templates.
//
// Share URLs reveal policy and allow one child key to be created per canonical
// client IP. The child bearer is returned only by the successful issue call.

import { Elysia } from "elysia";
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { models, providers } from "../../persistence/schema";
import { canonicalClientIpKey } from "../../security/ip-boundary";
import { decryptCredentialToString } from "../../security/crypto";
import { isModelAllowed, isProviderAllowed, type ApiKeyAuthorizationSnapshot } from "../../security/api-key-auth";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "../../security/outbound-headers";
import { generateApiKeySecret } from "../domains/api-keys/contracts";
import {
  hashShareToken,
  type ShareHandoffRow,
  type ShareLinkStore,
  type ShareApiKeyRow,
} from "../../persistence/share-store";

/** Minimum accepted token length; generated tokens are 43 base64url chars. */
const MIN_TOKEN_LENGTH = 20;

export interface ShareRouterOptions {
  readonly db: CartethyiaDatabase;
  readonly shareStore: ShareLinkStore;
  /** Resolves the normalized client IP through the trusted-proxy boundary. */
  readonly resolveClientIp: (request: Request) => string | null;
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
  return json({ error: { code: "link_not_found", message: "Share link is unavailable" } }, 404);
}

function providerOf(slug: string): string {
  const index = slug.indexOf("/");
  return index === -1 ? "" : slug.slice(0, index);
}

function modelPrefixAllows(
  prefix: string | null,
  providerId: string,
  modelId: string,
): boolean {
  return prefix === null || modelId.startsWith(prefix) || `${providerId}/${modelId}`.startsWith(prefix);
}

/** Resolves the models a share recipient may use. */
async function modelsForShare(db: CartethyiaDatabase, row: ShareApiKeyRow): Promise<string[]> {
  const snapshot: ApiKeyAuthorizationSnapshot = {
    api_key_id: row.id,
    tenant_id: row.tenantId,
    provider_allowlist: row.providerAllowlist,
    model_allowlist: row.modelAllowlist,
    model_denylist: row.modelDenylist,
  };
  const configured = row.modelAllowlist;
  if (configured !== null && configured.length > 0) {
    return configured
      .filter((slug) => {
        const providerId = providerOf(slug);
        const modelId = providerId === "" ? slug : slug.slice(providerId.length + 1);
        return (
          isProviderAllowed(snapshot, providerId) &&
          isModelAllowed(snapshot, modelId, providerId || undefined, slug) &&
          modelPrefixAllows(row.modelPrefix, providerId, modelId)
        );
      })
      .sort((left, right) => left.localeCompare(right));
  }
  const providerScope = or(isNull(providers.tenantId), eq(providers.tenantId, row.tenantId));
  const rows = await db
    .select({ providerId: models.providerId, modelId: models.modelId })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.enabled, true), providerScope));
  const slugs = new Set<string>();
  for (const entry of rows) {
    if (!isProviderAllowed(snapshot, entry.providerId)) continue;
    const slug = `${entry.providerId}/${entry.modelId}`;
    if (!isModelAllowed(snapshot, entry.modelId, entry.providerId, slug)) continue;
    if (!modelPrefixAllows(row.modelPrefix, entry.providerId, entry.modelId)) continue;
    slugs.add(slug);
  }
  return [...slugs].sort((left, right) => left.localeCompare(right));
}


/** Creates the public enrollment page and one-time shared-key issuance route. */
export function createShareRouter(options: ShareRouterOptions): Elysia {
  const { db, shareStore } = options;

  return new Elysia()
    /**
     * Handoff link for a personal key: reveals the key itself, never a child.
     * The link's authority is the same as the enrollment link's — possession of
     * the token — so a dead or revoked link resolves to nothing.
     */
    .get("/share/:token/handoff", async ({ params }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const row: ShareHandoffRow | null = await shareStore.getHandoffByShareToken(
        hashShareToken(token),
      );
      if (row === null) return notFound();
      let key: string | null = null;
      if (row.keyEncrypted !== null) {
        try {
          key = decryptCredentialToString(row.keyEncrypted);
        } catch {
          key = null;
        }
      }
      void shareStore.touchView(hashShareToken(token)).catch(() => undefined);
      return json({
        kind: "handoff",
        name: row.name,
        keyPrefix: row.keyPrefix,
        key,
        requestsPerMinute: row.requestsPerMinute,
        maxConcurrentRequests: row.maxConcurrentRequests,
        dailyLimit: row.dailyTokenLimit,
        monthlyLimit: row.monthlyTokenLimit,
        oneTimeLimit: row.lifetimeTokenBudget,
        modelAllowlist: row.modelAllowlist,
        notes: {
          title: row.notesTitle,
          subtitle: row.notesSubtitle,
          body: row.notesBody,
        },
        expiresAt: row.expiresAt,
      });
    })
    .get("/share/:token/data", async ({ params, request }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const tokenHash = hashShareToken(token);
      const row = await shareStore.getApiKeyByShareToken(tokenHash);
      if (row === null) return notFound();

      const clientIp = options.resolveClientIp(request);
      const clientIpKey = clientIp === null ? undefined : canonicalClientIpKey(clientIp);
      const [modelAllowlist, alreadyIssued] = await Promise.all([
        modelsForShare(db, row),
        clientIpKey === undefined ? false : shareStore.hasActiveSharedKeyForIp(clientIpKey),
      ]);
      void shareStore.touchView(tokenHash).catch(() => undefined);
      return json({
        name: row.name,
        keyPrefix: row.keyPrefix,
        canIssue: clientIpKey !== undefined && !alreadyIssued,
        alreadyIssued,
        dailyLimit: row.dailyTokenLimit,
        monthlyLimit: row.monthlyTokenLimit,
        oneTimeLimit: row.lifetimeTokenBudget,
        requestsPerMinute: row.requestsPerMinute,
        maxConcurrentRequests: row.maxConcurrentRequests,
        providerAllowlist: row.providerAllowlist,
        modelPrefix: row.modelPrefix,
        modelAllowlist,
        modelDenylist: row.modelDenylist,
        notes: {
          title: row.notesTitle,
          subtitle: row.notesSubtitle,
          body: row.notesBody,
        },
        expiresAt: row.expiresAt,
      });
    })
    .post("/share/:token/issue", async ({ params, request, set }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const clientIp = options.resolveClientIp(request);
      if (clientIp === null)
        return json({ error: { code: "client_ip_unavailable", message: "Client IP is unavailable" } }, 503);
      const clientIpKey = canonicalClientIpKey(clientIp);
      if (clientIpKey === undefined)
        return json({ error: { code: "client_ip_invalid", message: "Client IP could not be normalized" } }, 400);

      const tokenHash = hashShareToken(token);
      const template = await shareStore.getApiKeyByShareToken(tokenHash);
      if (template === null) return notFound();
      const generated = generateApiKeySecret(template.keyPrefix ?? undefined);
      const issued = await shareStore.issueSharedApiKey(tokenHash, {
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        clientIp,
        clientIpKey,
      });
      if (issued.kind === "link_unavailable") return notFound();
      if (issued.kind === "ip_limit") {
        return json(
          { error: { code: "shared_key_ip_limit", message: "This IP address already has an active shared API key" } },
          409,
        );
      }
      set.status = 201;
      return json({
        key: generated.secret,
        keyId: issued.apiKeyId,
        keyPrefix: issued.keyPrefix,
        createdAt: issued.createdAt.toISOString(),
      }, 201);
    }) as unknown as Elysia;
}
