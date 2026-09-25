/**
 * Console API composition root: assembles every console route group with
 * explicit persistence boundaries. All dependencies are injected at
 * composition time; concrete Drizzle stores are the defaults, so this file
 * is the single place that knows them.
 */
import { Elysia } from "elysia";
import { resolveConsoleAccess, resolveConsoleUser } from "./auth/session-resolver";
import { ConsoleCredentialService, FirstBootSetupService, ConsoleSessionService, defaultSessionCookiePolicy, ConsoleLockoutService, AuditRecorder } from "./auth/service";
import { createConsoleAuthRoutes } from "./auth/session";
import {
  createConsoleCsrfMiddleware,
  createConsoleMutationLimiterMiddleware,
} from "../transport/middleware/ingress";
import { registerConsoleDomains, type ConsoleDomainContext } from "./domain-registration";
import type { ConsoleAccessResolver } from "./auth/access";
import type { CartethyiaDatabase } from "../persistence/postgres";
import { createAccessDecision, type AccessDecision } from "../security/access-control";
import { resolveApiKeyAuthorization } from "../security/api-key-auth";
import type { RouteSnapshotService } from "../transport/routing/route-model";
import type { NetworkPoolSelector } from "../network/pool/selector";
import type { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import type { OAuthRefreshService } from "../providers/authentication/oauth-refresh-service";
import type { ApiKeyAdmissionService } from "../security/admission";
import type { RedisClient } from "../persistence/redis";
import { CliToolMappingStore } from "./cli-tools/store";
import { CliToolService } from "./cli-tools/service";
import { DrizzleCliToolSecretSource } from "./cli-tools/secret-source";
import type { ProviderRegistry } from "../providers/provider-registry";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import type { ValidatedNetworkBindingFactory } from "../network/pool/resolver";
import type { TrustedProxyBoundary } from "../config";

export interface ConsoleApiCompositionDeps {
  readonly db: CartethyiaDatabase;
  readonly accessResolver: ConsoleAccessResolver;
  readonly routeSnapshotService: RouteSnapshotService;
  readonly poolSelector: NetworkPoolSelector;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  readonly providerRegistry: ProviderRegistry;
  readonly bundledModelCatalog: BundledProviderCatalog;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
  readonly redis: RedisClient;
  readonly oauthRefreshService: OAuthRefreshService;
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey">;
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
    providerRegistry: deps.providerRegistry,
    bundledModelCatalog: deps.bundledModelCatalog,
    networkBindingFactory: deps.networkBindingFactory,
    admissionService: deps.admissionService,
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
  return console as unknown as Elysia;
}
