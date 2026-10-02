// Gateway guards: API-key auth, console CSRF + mutation limit, readiness, IP abuse.
import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { GatewayError } from "../gateway-error";
import type { TrustedProxyBoundary } from "../../config";
import { resolveClientIdentity } from "../../security/ip-boundary";
import type { ProxyRequestStateStore } from "../request/state";
import { fastPathname } from "../request/pathname";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { requestToken, resolveApiKeyAuthorization } from "../../security/api-key-auth";
import {
  deniedClientRouter,
  detectClientRouter,
} from "../../security/client-router-fingerprint";
import { createAccessDecision } from "../../security/access-control";
import { parseCookieValue, SESSION_COOKIE_NAME, isCsrfValid } from "../../security/csrf";
import type { IpAbuseProtectionService } from "../../security/abuse";
import { modelAbuseBannedError, type ModelStrikeService } from "../../security/model-abuse";
import type { ReadinessCheckResult } from "../../persistence/readiness";
import { shutdownNotice } from "../shutdown-notice";

/**
 * Stateless Elysia `beforeHandle` gateway checks: API-key authentication,
 * console CSRF, dependency readiness, and IP-abuse protection — all wired
 * into the same middleware chain in `app.ts`.
 */

export function createApiKeyAuthenticationMiddleware(deps: {
  readonly db: CartethyiaDatabase;
  readonly stateStore: ProxyRequestStateStore;
  /**
   * Model-abuse ban gate. A banned IP or key is refused here, before the
   * canonical parse and route preparation, and before `state.authorization` is
   * assigned — so a banned caller's attempts produce no telemetry row and no
   * console error, which is exactly the noise this layer exists to stop.
   */
  readonly modelStrikes?: Pick<ModelStrikeService, "check">;
}): Elysia {
  // Single policy for every `/v1/*` gateway route: authenticated, scoped to
  // `routing:invoke`, and tenant-bound (the snapshot's tenant is the only
  // tenant this key may address). The check is inline rather than routed
  // through a per-route policy table: Elysia's router already owns which
  // paths exist, so a per-route table only added a second place to keep in
  // sync.
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const pathname = fastPathname(request.url);
      if (!pathname.startsWith("/v1/")) return;
      const token = requestToken(request.headers);
      const authorization = await resolveApiKeyAuthorization(deps.db, token);
      if (!authorization)
        throw new GatewayError("invalid_request", 401, "invalid or revoked API key");
      const decision = createAccessDecision({
        id: authorization.id,
        tenantId: authorization.tenantId,
        scopes: authorization.scopes,
      });
      if (!decision.scopes.includes("routing:invoke"))
        throw new GatewayError("invalid_request", 403, "API key lacks routing:invoke scope");
      // A key may refuse a downstream router it has been resold to. This is a
      // policy check on the resolved key, so it belongs with the other
      // authorization decisions rather than in routing: the request is refused
      // before a route is planned or an upstream is touched.
      const denied = deniedClientRouter(
        authorization.snapshot.client_router_denylist,
        detectClientRouter({ headers: request.headers }),
      );
      if (denied !== null)
        throw new GatewayError(
          "client_router_denied",
          403,
          "No API invocation access for this client.",
          { reason: "client_router_denied", clientRouter: denied },
        );
      // Abuse ban: refuse before parse/prepare and before authorization is
      // recorded, so a banned caller cannot keep producing failed rows. The ban
      // is keyed on the client address, not the key: one key can be shared by
      // every recipient of a share link, so refusing the key would punish
      // callers that did nothing.
      if (deps.modelStrikes) {
        const state = deps.stateStore.get(request);
        const ip = state?.clientIdentity?.address;
        if (ip !== undefined) {
          const banned = await deps.modelStrikes.check({ ip }).catch(() => false);
          if (banned) throw modelAbuseBannedError();
        }
      }
      deps.stateStore.require(request).authorization = authorization;
    })
    .as("plugin");
}

/**
 * Stateless double-submit CSRF guard for unsafe `/console/api/*` mutations.
 * Compares the `x-csrf-token` header against the readable `csrf_token`
 * cookie — zero database I/O, so dashboard writes no longer pay a token
 * SELECT + UPDATE on top of the session lookup, and there is no token
 * store whose outage could masquerade as an auth failure.
 */
export function createConsoleCsrfMiddleware(): Elysia {
  const excluded = ["/auth/login", "/auth/setup", "/auth/session"];
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        !path.startsWith("/console/api/") ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
        excluded.some((suffix) => path.endsWith(suffix))
      )
        return;
      const token = parseCookieValue(request, SESSION_COOKIE_NAME);
      // No session cookie means no ambient authority to forge: logout and
      // other mutations without a session fail authentication downstream.
      // CSRF enforcement applies exactly when a session cookie is present.
      if (!token) return;
      if (!isCsrfValid(request))
        throw new GatewayError("invalid_request", 403, "CSRF validation failed");
    })
    .as("plugin");
}

/**
 * Per-session console mutation throttle: at most 240 unsafe requests per
 * 10-second sliding window per session. A stolen session cookie can
 * otherwise rewrite settings, rotate keys, or trigger restores at full
 * request rate; this bounds the blast radius while staying far above
 * legitimate bulk operations (bulk-deleting 40+ fetched models fires one
 * DELETE per model as fast as the loop runs, plus interleaved probes).
 * Keyed by session-cookie hash (never the raw secret); mutations without a
 * session fail authentication downstream and are not tracked. Exceeding
 * requests get 429 with `retry-after` instead of executing.
 */
const CONSOLE_MUTATION_LIMIT = 240;
const CONSOLE_MUTATION_WINDOW_MS = 10_000;
const CONSOLE_MUTATION_MAX_KEYS = 1024;
const consoleMutationHits = new Map<string, number[]>();

function consoleMutationKey(request: Request): string | undefined {
  const token = parseCookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return undefined;
  return createHash("sha256").update(token).digest("hex");
}

function pruneConsoleMutationHits(now: number): void {
  for (const [key, hits] of consoleMutationHits) {
    while (hits.length > 0 && (hits[0] as number) <= now - CONSOLE_MUTATION_WINDOW_MS) hits.shift();
    if (hits.length === 0) consoleMutationHits.delete(key);
  }
  while (consoleMutationHits.size > CONSOLE_MUTATION_MAX_KEYS) {
    const oldest = consoleMutationHits.keys().next().value;
    if (oldest === undefined) return;
    consoleMutationHits.delete(oldest);
  }
}

export function createConsoleMutationLimiterMiddleware(): Elysia {
  const excluded = ["/auth/login", "/auth/setup", "/auth/session"];
  return new Elysia()
    .beforeHandle(async ({ request, set }) => {
      const path = fastPathname(request.url);
      if (
        !path.startsWith("/console/api/") ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
        excluded.some((suffix) => path.endsWith(suffix))
      )
        return;
      const key = consoleMutationKey(request);
      // No session cookie means no ambient authority to abuse: the request
      // fails authentication downstream. Only tracked sessions are throttled.
      if (key === undefined) return;
      const now = Date.now();
      pruneConsoleMutationHits(now);
      const hits = consoleMutationHits.get(key) ?? [];
      if (hits.length >= CONSOLE_MUTATION_LIMIT) {
        // Measured, not a literal: the wait is however long the oldest tracked
        // mutation still needs to age out of the window. A hardcoded value had
        // to be kept in step with `CONSOLE_MUTATION_WINDOW_MS` by hand.
        const oldest = hits[0];
        const retryAfterSeconds =
          oldest === undefined
            ? Math.ceil(CONSOLE_MUTATION_WINDOW_MS / 1000)
            : Math.max(1, Math.ceil((oldest + CONSOLE_MUTATION_WINDOW_MS - now) / 1000));
        set.headers["retry-after"] = String(retryAfterSeconds);
        throw new GatewayError("quota_exceeded", 429, "Console mutation rate limit exceeded");
      }
      hits.push(now);
      consoleMutationHits.set(key, hits);
    })
    .as("plugin");
}

export interface ShutdownDrainSource {
  isDraining(): boolean;
  /** Why the drain began, so the notice can tell a stop from an update. */
  shutdownReason?(): string;
}

export interface ReadinessMiddlewareDeps {
  readonly readiness: () => Promise<ReadinessCheckResult>;
  readonly shutdownCoordinator?: ShutdownDrainSource;
}
export function createDependencyReadinessMiddleware(deps: ReadinessMiddlewareDeps): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        path === "/health" ||
        path === "/health/ready" ||
        (!path.startsWith("/v1/") && !path.startsWith("/console/api/"))
      )
        return;
      if (deps.shutdownCoordinator?.isDraining()) {
        const notice = shutdownNotice(deps.shutdownCoordinator.shutdownReason?.());
        throw new GatewayError(notice.code, 503, notice.message);
      }
      const readiness = await deps.readiness();
      if (readiness.status !== "ready")
        throw new GatewayError("platform_unavailable", 503, "Service dependencies are unavailable");
    })
    .as("plugin");
}

/**
 * Counts every `/v1/*` attempt against the per-IP ceiling, including the ones
 * that never reach a route.
 *
 * Mounted at the root through the `request` hook, deliberately not as a
 * gateway plugin stage. A plugin `beforeHandle` only runs for a request that
 * matches a registered route, and so does a root `beforeHandle` â€” measured:
 * 300 attempts rotating unregistered `/v1/*` paths produced zero 429s and no
 * ban, while the same attempts against a real route escalated normally. A
 * caller that has already decided to hammer the gateway could therefore pick
 * the cheapest evasion available: address a path that does not exist, or a
 * real path with the wrong method, and the counter was never touched. Only
 * the root `request` hook runs for every inbound request regardless of
 * whether anything matches it.
 *
 * The root `request` hook runs ahead of the gateway plugin's `beforeHandle`
 * chain, so the counter still executes before authentication: an
 * unauthenticated attempt is counted, and a rejected attempt keeps counting
 * toward the ban â€” which is the escalation path, not an exemption from it.
 * Throwing here short-circuits the request, so a banned or over-limit caller
 * is rejected before it can reach routing.
 */
export function createIpAbuseProtectionMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly ipAbuseProtection: IpAbuseProtectionService;
  readonly trustedProxyBoundary: TrustedProxyBoundary;
  readonly resolvePeerAddress?: (request: Request) => string | null;
}): Elysia {
  const app = new Elysia() as unknown as {
    request(
      handler: (context: {
        request: Request;
        server?: { requestIP(request: Request): { address: string } | null };
      }) => void | Promise<void>,
    ): unknown;
  };
  app.request(async ({ request, server }) => {
    const path = fastPathname(request.url);
    if (
      path === "/health" ||
      path === "/health/ready" ||
      // Scoped to /v1/* only: /console/api/auth/* already has its own
      // fail-closed, DB-persisted ConsoleLockoutService with a lower
      // (5-failure) threshold that always trips first â€” running both
      // here paid a second sequential counter per login with zero
      // effect (dual-throttler refinement pass).
      !path.startsWith("/v1/")
    )
      return;
    // The client identity is resolved here rather than read off request state:
    // this hook runs at the root, ahead of the gateway plugin's `beforeHandle`
    // chain, so `state.clientIdentity` is not populated yet. Resolving it from
    // the same boundary the identity middleware uses keeps one answer for the
    // same request, and keeps the counter independent of middleware ordering.
    const peer = deps.resolvePeerAddress
      ? deps.resolvePeerAddress(request)
      : (server?.requestIP(request)?.address ?? null);
    if (!peer)
      throw new GatewayError("admission_unavailable", 503, "client peer address unavailable");
    const address = resolveClientIdentity(request, deps.trustedProxyBoundary, peer);
    const state = deps.stateStore.get(request);
    try {
      await deps.ipAbuseProtection.checkBeforeAccess({
        identity: {
          address,
          source: address === peer ? "tcp-peer" : "trusted-forwarded-header",
        },
        route: path,
        ...(state === undefined ? {} : { signal: state.abortController.signal }),
      });
    } catch (error) {
      // No fixed `retry-after` here. The store measures the real remainder â€”
      // a ban's marker TTL, or the age of the oldest attempt in a rate-limited
      // window â€” and carries it as `retryAfterMs`, which the error
      // normalization middleware turns into the header. Assigning a constant
      // here pre-empted that hint (`retry-after` is only filled when unset) and
      // told a client facing a 60-second window to wait a full hour.
      throw error;
    }
  });
  return app as unknown as Elysia;
}



