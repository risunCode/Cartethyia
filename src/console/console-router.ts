/**
 * Console API composition root: assembles every console route group with
 * explicit persistence boundaries. All dependencies are injected at
 * composition time; concrete Drizzle stores are the defaults, so this file
 * is the single place that knows them.
 */
import { Elysia } from "elysia";
import { log } from "../observability/logger";
import { resolveConsoleAccess, resolveConsoleUser } from "./auth/session-resolver";
import { ConsoleCredentialService } from "./auth/credentials";
import { resolveDefaultGatewayApiKey } from "../config/runtime";
import { FirstBootSetupService } from "./auth/setup-service";
import { ConsoleSessionService, defaultSessionCookiePolicy } from "./auth/session-service";
import { ConsoleLockoutService } from "./auth/lockout";
import { AuditRecorder } from "./auth/audit-recorder";
import { createConsoleAuthRoutes } from "./auth/session";
import { createConsoleCsrfMiddleware } from "./console-router-guards";
import { createConsoleMutationLimiterMiddleware } from "./console-router-guards";
import { registerConsoleDomains, type ConsoleDomainContext } from "./domain-registration";
import type { ConsoleAccessResolver } from "./auth/access";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { createAccessDecision, type AccessDecision } from "../security/access-control";
import { resolveApiKeyAuthorization } from "../security/api-key-auth";
import type { LiveInFlightSource } from "./observability/live";
import type { NetworkPoolSelector } from "../network/pool/selector";
import type { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import type { OAuthRefreshService } from "../providers/authentication/oauth-refresh-service";
import type { ApiKeyAdmissionService } from "../security/admission/service";
import type { ModelStrikeService } from "../security/model-abuse";
import type { RedisClient } from "../persistence/redis";
import { CliToolMappingStore } from "./cli-tools/store";
import { CliToolService } from "./cli-tools/service";
import { DrizzleCliToolSecretSource } from "./cli-tools/secret-source";
import type { ProviderRegistry } from "../providers/registry";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import type { ValidatedNetworkBindingFactory } from "../network/pool/resolver";
import type { TrustedProxyBoundary } from "../config/network";
import { gzipResponse } from "./response-compression";

export interface ConsoleApiCompositionDeps {
  readonly db: CartethyiaDatabase;
  readonly accessResolver: ConsoleAccessResolver;
  /**
   * Drops the cached route snapshot after a console write changes the catalog.
   * Structurally satisfied by `RouteSnapshotService`; declared here so the
   * console composition root does not import the transport layer.
   */
  readonly routeSnapshotService: { invalidate(): Promise<number> };
  readonly poolSelector: NetworkPoolSelector;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  /**
   * The request state store owns the live in-flight gauge, so the console reads
   * its snapshot/subscription from here rather than a free-standing module.
   */
  readonly stateStore?: LiveInFlightSource;
  readonly providerRegistry: ProviderRegistry;
  readonly bundledModelCatalog: BundledProviderCatalog;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
  readonly redis: RedisClient | undefined;
  readonly oauthRefreshService: OAuthRefreshService;
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey">;
  /**
   * Graduated model-abuse strikes: list and lift bans from the console.
   * Optional so reduced compositions (route-only shell, console stubs) stay
   * valid; absent means the `/model-bans` routes are not mounted.
   */
  readonly modelStrikes?: Pick<ModelStrikeService, "listBans" | "unban">;
  readonly readRoutingAccountInflight?:
    | ((
        providerId: string,
        tenantId: string | null,
      ) => Promise<readonly { accountId: string; inflight: number }[]>)
    | undefined;
  readonly resolvePeerAddress?: (request: Request) => string | null;
  readonly trustedProxyBoundary?: TrustedProxyBoundary;
}
/**
 * Extracts a bearer API key from a console request, or `undefined`.
 *
 * Deliberately narrower than the proxy surface's `requestToken`: that one also
 * accepts `x-api-key` and throws on a malformed header, because a proxy caller
 * must be told its credential is wrong. Here the header is only an *alternative*
 * to a session cookie, so an absent or unparsable one means "not a key" and the
 * request proceeds as an unauthenticated session request — which the routes
 * then reject with their own 401. Returning `undefined` rather than throwing
 * keeps a browser that sends a stray Authorization header from being told its
 * session is invalid.
 */
function readApiKeyBearer(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}

export function createConsoleRouter(deps: ConsoleApiCompositionDeps): Elysia {
  const { db, routeSnapshotService, poolSelector, telemetryBuffer, redis } = deps;
  /**
   * Per-request cache: `beforeHandle` resolves the session asynchronously, and
   * the sync `ConsoleAccessResolver` contract reads the decision back out of
   * it. Scoped to this composition rather than the module so two routers in one
   * process (tests, or a second app instance) never share decisions.
   */
  const sessionAccessCache = new WeakMap<Request, AccessDecision | null>();
  const cookiePolicy = defaultSessionCookiePolicy;
  const credentialService = new ConsoleCredentialService();
  const sessionService = new ConsoleSessionService(db, cookiePolicy);
  const lockoutService = new ConsoleLockoutService(db);
  const setupService = new FirstBootSetupService(db, credentialService);
  // The default gateway key is seeded only when the first-boot wizard runs, so a
  // key set in the environment does nothing until an operator completes setup.
  // Fire and forget: a failed check must not stop the console from mounting.
  void setupService.requiresSetup().then((needsSetup) => {
    if (needsSetup && resolveDefaultGatewayApiKey() !== undefined) {
      log.warn(
        "[setup] CARTETHYIA_API_KEY is set but no console user exists yet; complete the first-boot wizard at /console so the key is seeded",
      );
    }
  }).catch((error: unknown) => {
    log.warn("[setup] could not check first-boot state", error);
  });
  const auditRecorder = new AuditRecorder(db);
  const cliToolService = new CliToolService(
    new CliToolMappingStore(db),
    new DrizzleCliToolSecretSource(db),
  );
  const accessResolver: ConsoleAccessResolver = (request) =>
    deps.accessResolver(request) ?? sessionAccessCache.get(request) ?? undefined;
  const console = new Elysia({ prefix: "/console/api" })
    .use(createConsoleCsrfMiddleware())
    .use(createConsoleMutationLimiterMiddleware())
    .beforeHandle(async ({ request }: { request: Request }) => {
      // The auth routes (`/console/api/auth/*`) resolve the session themselves
      // and never read `accessResolver`, so resolving here too would repeat the
      // session lookup plus its user query on every login/session/logout call
      // for a decision nothing consumes. Skip them.
      if (new URL(request.url).pathname.startsWith("/console/api/auth/")) return;
      const access = await resolveConsoleAccess(db, sessionService, request);
      if (access) {
        sessionAccessCache.set(request, access);
        return;
      }
      // No session cookie. A tenant API key may still reach the catalog routes
      // it is scoped for — that is what lets a key register a BYOK provider or
      // add a model without a browser session. The key is resolved through the
      // same path `/v1` uses, so scopes and revocation behave identically, and
      // a request carrying no credential at all stays unauthenticated (the
      // routes reject it) rather than falling back to an implicit identity.
      const bearer = readApiKeyBearer(request);
      if (bearer === undefined) return;
      const resolved = await resolveApiKeyAuthorization(db, bearer);
      if (resolved === undefined) return;
      sessionAccessCache.set(
        request,
        createAccessDecision({
          id: resolved.id,
          tenantId: resolved.tenantId,
          scopes: resolved.scopes,
          admissionIdentity: resolved.id,
        }),
      );
    })
    .use(
      createConsoleAuthRoutes(
        db,
        credentialService,
        sessionService,
        lockoutService,
        setupService,
        cookiePolicy,
        deps.trustedProxyBoundary ?? { mode: "disabled" },
        (request) => deps.resolvePeerAddress?.(request) ?? undefined,
      ),
    );
  const ctx: ConsoleDomainContext = {
    db,
    accessResolver,
    auditRecorder,
    oauthRefreshService: deps.oauthRefreshService,
    cliToolService,
    redis,
    routeSnapshotService,
    poolSelector,
    telemetryBuffer,
    ...(deps.stateStore ? { stateStore: deps.stateStore } : {}),
    providerRegistry: deps.providerRegistry,
    bundledModelCatalog: deps.bundledModelCatalog,
    networkBindingFactory: deps.networkBindingFactory,
    admissionService: deps.admissionService,
    ...(deps.modelStrikes ? { modelStrikes: deps.modelStrikes } : {}),
    readRoutingAccountInflight: deps.readRoutingAccountInflight,
    credentialService,
    // The backup surface re-authenticates the operator, so it needs the current
    // user's hash. Read from the session on the request that asks for it, never
    // cached in a field, so a password change or a deactivated user takes
    // effect on the very next attempt.
    loadConsoleUser: async (request: Request) => {
      const user = await resolveConsoleUser(db, sessionService, request);
      return user === null ? null : { passwordHash: user.passwordHash };
    },
  };
  registerConsoleDomains(console as unknown as Elysia, ctx);
  // Compress the JSON control plane on the way out.
  //
  // `wrap` is used rather than a lifecycle hook because this Elysia beta does
  // not deliver the response body to them: measured, both `mapResponse` and
  // `afterHandle` receive `responseValue`/`response` as `undefined` for a
  // plain-object route, and Elysia sets no `content-length`, so a hook has
  // nothing to compress and no size to judge. `wrap` sits outside the router
  // and sees the finished `Response`, which is what this needs.
  //
  // Scoped to the console instance: `/v1/*` is a separate Elysia and is
  // deliberately not covered, because a streaming completion must not be
  // buffered and proxied bodies are the provider's own bytes. See
  // `response-compression.ts` for the full reasoning and the measured win.
  console.wrap(
    (fetch) => (request: Request, ...rest: unknown[]) =>
      Promise.resolve(fetch(request, ...rest)).then((response) =>
        gzipResponse(request, response),
      ),
  );
  return console as unknown as Elysia;
}
