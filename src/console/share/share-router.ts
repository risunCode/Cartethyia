// Public enrollment routes for shared API-key templates.
//
// Share URLs reveal policy and allow one child key to be created per canonical
// client IP. The child bearer is returned only by the successful issue call.

import { Elysia } from "elysia";
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { apiKeys, models, providers } from "../../persistence/schema";
import { PublicModelCatalogStore } from "../providers/catalog/public-model-store";
import { canonicalClientIpKey } from "../../security/ip-boundary";
import { decryptCredentialToString } from "../../security/crypto";
import { isModelAllowed, type ApiKeyAuthorizationSnapshot } from "../../security/api-key-auth";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "../../security/outbound-headers";
import { SHARED_CHILD_HINT_MAX_LENGTH, generateApiKeySecret } from "../domains/api-keys/contracts";
import { popupImageBytes } from "../domains/api-keys/share-popup-image";
import type { ShareFamilyStats, ShareStatsPort } from "./share-stats";
import { consoleSseResponse, createConsoleSseStream } from "../observability/sse";
import { GatewayError, publicGatewayErrorBody } from "../../transport/gateway-error";
import {
  hashShareToken,
  type ShareLinkPolicy,
  type ShareLinkStore,
} from "../../persistence/share-store";

/** Minimum accepted token length; generated tokens are 43 base64url chars. */
const MIN_TOKEN_LENGTH = 20;

/**
 * Cadence of the share stats SSE snapshot. Short enough to read as live;
 * the rollup itself is a handful of indexed aggregates, so re-reading on this
 * interval is cheap next to the per-request telemetry insert it summarizes.
 */
const SHARE_STATS_STREAM_INTERVAL_MS = 2_000;

/**
 * Context and capabilities for one allowed model, sourced from the public
 * catalog. Every field is nullable/optional so the page can show what is known
 * and omit the rest rather than invent a value.
 */
export interface ShareModelInfo {
  readonly contextLength: number | null;
  readonly maxOutputTokens: number | null;
  readonly capabilities: { readonly input?: string[]; readonly output?: string[] } | null;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly webSearch: boolean;
}

export interface ShareRouterOptions {
  readonly db: CartethyiaDatabase;
  readonly shareStore: ShareLinkStore;
  /** Resolves the normalized client IP through the trusted-proxy boundary. */
  readonly resolveClientIp: (request: Request) => string | null;
  /** Family-wide activity rollup for the share page. Omitted in tests that do not exercise it. */
  readonly stats?: ShareStatsPort;
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
  const error = new GatewayError("link_not_found", 404, "Share link is unavailable");
  return json(publicGatewayErrorBody(error), error.status);
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

/** The authorization snapshot a share link's own policy implies. */
function snapshotForShare(row: ShareLinkPolicy): ApiKeyAuthorizationSnapshot {
  return {
    api_key_id: row.id,
    tenant_id: row.tenantId,
    model_allowlist: row.modelAllowlist,
    model_denylist: row.modelDenylist,
  };
}

/**
 * Context window and capabilities for each allowed model, keyed by the name as
 * it appears in `modelAllowlist`.
 *
 * Read from the same `models` catalog `/v1/models` answers from, so the share
 * page and the API never disagree about what a model can do. An entry may be
 * bare (`glm-5.3-flash`) or provider-qualified (`openai/gpt-6-luna`); both match
 * a catalog row by its model id. A name with no catalog row is simply absent —
 * the page renders the id without a spec rather than inventing one.
 */
async function modelInfoForShare(
  db: CartethyiaDatabase,
  row: ShareLinkPolicy,
  allowedModels: readonly string[],
): Promise<Record<string, ShareModelInfo>> {
  if (allowedModels.length === 0) return {};
  const catalog = new PublicModelCatalogStore(db);
  const metadata = await catalog.metadataForNames(row.tenantId, allowedModels);
  const info: Record<string, ShareModelInfo> = {};
  for (const name of allowedModels) {
    const entry = metadata.get(name);
    if (!entry) continue;
    info[name] = {
      contextLength: entry.contextLimit ?? null,
      maxOutputTokens: entry.outputLimit ?? null,
      capabilities: normalizeShareCapabilities(entry.modalities),
      reasoning: entry.reasoning,
      toolCall: entry.toolCall,
      webSearch: entry.webSearch,
    };
  }
  return info;
}

/** Input/output modalities a model advertises, or null when it states none. */
function normalizeShareCapabilities(
  value: unknown,
): { readonly input?: string[]; readonly output?: string[] } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { input?: unknown; output?: unknown };
  const pick = (candidate: unknown): string[] | undefined =>
    Array.isArray(candidate) && candidate.every((v) => typeof v === "string")
      ? (candidate as string[])
      : undefined;
  const input = pick(record.input);
  const output = pick(record.output);
  if (input === undefined && output === undefined) return null;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

/** Resolves the models a share recipient may use. */
async function modelsForShare(db: CartethyiaDatabase, row: ShareLinkPolicy): Promise<string[]> {
  const snapshot = snapshotForShare(row);
  const configured = row.modelAllowlist;
  if (configured !== null && configured.length > 0) {
    return configured
      .filter((slug) => {
        const providerId = providerOf(slug);
        const modelId = providerId === "" ? slug : slug.slice(providerId.length + 1);
        return (
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
    const slug = `${entry.providerId}/${entry.modelId}`;
    if (!isModelAllowed(snapshot, entry.modelId, entry.providerId, slug)) continue;
    if (!modelPrefixAllows(row.modelPrefix, entry.providerId, entry.modelId)) continue;
    slugs.add(slug);
  }
  return [...slugs].sort((left, right) => left.localeCompare(right));
}


/**
 * Family-wide activity for one share token, or `null` when the token does not
 * resolve. Shared by the one-shot stats route and its SSE stream so both read
 * exactly the same rollup — a drifting second copy would let the live view and
 * the fetched snapshot disagree.
 */
async function resolveFamilyStats(
  db: CartethyiaDatabase,
  shareStore: ShareLinkStore,
  stats: ShareStatsPort,
  token: string,
): Promise<ShareFamilyStats | null> {
  const resolved = await shareStore.resolveShareLink(hashShareToken(token));
  if (resolved === null) return null;
  const templateId = resolved.key.id;
  const tenantId = resolved.key.tenantId;
  const children = await db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.parentKeyId, templateId));
  const active = children.filter((child) => child.revokedAt === null).length;
  const keyIds = [templateId, ...children.map((child) => child.id)];
  // Rank only the models this link grants. A refused request still writes a
  // telemetry row carrying the name the client asked for, so an unfiltered
  // top-models table would list the very names the grant excludes. An
  // unrestricted link (no allowlist) passes `undefined` and ranks everything —
  // there is nothing to exclude, and filtering against the enabled catalog
  // would hide real traffic for a model the catalog does not describe.
  const configured = resolved.key.modelAllowlist;
  const allowedModels =
    configured !== null && configured.length > 0
      ? await modelsForShare(db, resolved.key)
      : undefined;
  return stats.getFamilyStats(tenantId, keyIds, { total: children.length, active }, allowedModels);
}

/** Creates the public enrollment page and one-time shared-key issuance route. */
export function createShareRouter(options: ShareRouterOptions): Elysia {
  const { db, shareStore } = options;

  return new Elysia()
    /**
     * Resolves a link to its policy and, for a handoff link, the key it
     * reveals.
     *
     * One endpoint serves both kinds because a token is exactly one of them. A
     * page that had to guess the kind sent a personal key's handoff link to the
     * enrollment lookup, which answered 404 for a link that was live — the
     * recipient saw "link unavailable" for a URL the console had just handed
     * out.
     */
    .get("/share/:token/data", async ({ params, request }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const tokenHash = hashShareToken(token);
      const resolved = await shareStore.resolveShareLink(tokenHash);
      if (resolved === null) return notFound();
      const row = resolved.key;
      const clientIp = options.resolveClientIp(request);
      const clientIpKey = clientIp === null ? undefined : canonicalClientIpKey(clientIp);
      const [modelAllowlist, alreadyIssued] = await Promise.all([
        modelsForShare(db, row),
        // Only an enrollment link hands out keys, so only it can be exhausted
        // by the one-active-key-per-IP rule.
        resolved.kind === "enroll" && clientIpKey !== undefined
          ? shareStore.hasActiveSharedKeyForIp(clientIpKey)
          : Promise.resolve(false),
      ]);
      const modelInfo = await modelInfoForShare(db, row, modelAllowlist);
      void shareStore.touchView(tokenHash).catch(() => undefined);
      const policy = {
        name: row.name,
        keyPrefix: row.keyPrefix,
        dailyLimit: row.dailyTokenLimit,
        monthlyLimit: row.monthlyTokenLimit,
        oneTimeLimit: row.lifetimeTokenBudget,
        requestsPerMinute: row.requestsPerMinute,
        maxConcurrentRequests: row.maxConcurrentRequests,
        modelPrefix: row.modelPrefix,
        modelAllowlist,
        modelInfo,
        modelDenylist: row.modelDenylist,
        notes: {
          title: row.notesTitle,
          subtitle: row.notesSubtitle,
          body: row.notesBody,
        },
        sharePopup: {
          enabled: row.sharePopupEnabled,
          hasImage: row.sharePopupImage !== null,
          title: row.sharePopupTitle,
          body: row.sharePopupBody,
        },
        expiresAt: row.expiresAt,
      };
      if (resolved.kind === "handoff") {
        // The link exists and is authorized; only its retained ciphertext can
        // be missing, which happens for a row written before token retention or
        // under a rotated encryption key. That is a page with nothing to
        // reveal, not a link the recipient mistyped.
        let key: string | null = null;
        if (resolved.key.keyEncrypted !== null) {
          try {
            key = decryptCredentialToString(resolved.key.keyEncrypted);
          } catch {
            key = null;
          }
        }
        return json({ kind: "handoff", key, ...policy });
      }
      return json({
        kind: "enroll",
        canIssue: clientIpKey !== undefined && !alreadyIssued,
        alreadyIssued,
        ...policy,
      });
    })
    /**
     * The owner-uploaded popup art. It is served from the same bearer token as
     * the page itself, so a link that stops resolving stops exposing the image.
     */
    .get("/share/:token/popup-image", async ({ params }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const resolved = await shareStore.resolveShareLink(hashShareToken(token));
      const image = resolved?.key.sharePopupImage;
      const mime = resolved?.key.sharePopupImageMime;
      if (!image || !mime) return notFound();
      return new Response(new Blob([popupImageBytes(image)], { type: mime }), {
        headers: {
          "content-length": String(image.byteLength),
          // Per-link content: a shared cache keyed only by path would keep
          // serving it after the token stops resolving.
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
        },
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
      const resolved = await shareStore.resolveShareLink(tokenHash);
      // A handoff link reveals an existing key; it never mints one.
      if (resolved === null || resolved.kind !== "enroll") return notFound();
      // The recipient supplies the label hint; policy still comes exclusively from the template.
      let nameHint: string;
      try {
        const body = (await request.json()) as { nameHint?: unknown };
        if (typeof body.nameHint !== "string" || body.nameHint.trim().length === 0) {
          return json({ error: { code: "name_required", message: "Your name is required" } }, 400);
        }
        nameHint = body.nameHint.trim().slice(0, SHARED_CHILD_HINT_MAX_LENGTH);
      } catch {
        return json({ error: { code: "name_required", message: "Your name is required" } }, 400);
      }
      const template = resolved.key;
      const generated = generateApiKeySecret(template.keyPrefix ?? undefined);
      const issued = await shareStore.issueSharedApiKey(tokenHash, {
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        clientIp,
        clientIpKey,
        nameHint,
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
    })
    /**
     * Family-wide activity for the share page's stats section.
     *
     * Aggregates every key the link has issued, not just the caller's own: the
     * quota is shared, so a per-recipient figure would understate what the link
     * has actually spent. The same bearer token that opens the page authorizes
     * this, and the response carries masked IPs only — it is rendered outside
     * the tenant.
     */
    .get("/share/:token/stats", async ({ params }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const stats = options.stats;
      if (!stats) return json({ error: { code: "stats_unavailable", message: "Stats are unavailable" } }, 503);
      const family = await resolveFamilyStats(db, shareStore, stats, token);
      if (family === null) return notFound();
      return json(family);
    })
    /**
     * Live family activity for the share page's stats section, pushed over SSE.
     *
     * The stream sends one snapshot immediately on connect, then re-reads on a
     * short cadence so the recipient watches the shared quota move instead of
     * refreshing. Telemetry is buffered server-side and drained in under a
     * second, so a DB re-read on this cadence is as fresh as an event bus would
     * be. Same bearer token and same masked-IP rollup as the one-shot route; a
     * token that stops resolving closes the stream rather than reporting zeros.
     */
    .get("/share/:token/stats/stream", async ({ params, request }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const stats = options.stats;
      if (!stats) return json({ error: { code: "stats_unavailable", message: "Stats are unavailable" } }, 503);
      return consoleSseResponse(
        createConsoleSseStream(request.signal, (sender) => {
          let closed = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const push = async () => {
            const family = await resolveFamilyStats(db, shareStore, stats, token);
            if (closed) return;
            if (family === null) {
              sender.send("error", { code: "link_not_found" });
              closed = true;
              return;
            }
            sender.send("stats", family);
          };
          const schedule = () => {
            timer = setTimeout(() => {
              if (closed) return;
              void push().finally(() => {
                if (!closed) schedule();
              });
            }, SHARE_STATS_STREAM_INTERVAL_MS);
          };
          void push().finally(() => {
            if (!closed) schedule();
          });
          return () => {
            closed = true;
            clearTimeout(timer);
          };
        }),
      );
    }) as unknown as Elysia;
}
