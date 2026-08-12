/**
 * Console application services — the authenticated control plane.
 *
 * Every operation that changes providers, accounts, proxies, keys, models,
 * quotas, or routing goes through an application service that talks to
 * injected repository ports — never to SQLite or provider internals
 * directly. The application contracts in `src/application/contracts.ts` are the
 * only cross-layer shapes used here.
 *
 * Security invariants:
 * - Mutations require an authenticated session, JSON content type, and
 *   non-cross-site Fetch Metadata; direct origins and same-origin browser
 *   proxies are accepted. Session cookies are HttpOnly + SameSite with a
 *   Secure attribute when served over HTTPS (see {@link guardConsoleRequest}
 *   and the cookie helpers in `./session.ts`).
 * - List/detail payloads never include secrets; only bounded credential
 *   hints and sanitized messages. Secrets are returned solely by the
 *   explicit credential endpoints.
 * - Route switch metadata always keeps the failed route and the replacement
 *   route as separate values.
 *
 * Re-exports view/repository contracts from `./views.ts`, session security
 * from `./session.ts`, route transition store from `./route-transitions.ts`,
 * and input sanitizers from `./input-sanitizers.ts` so existing consumers
 * importing from `"./services"` continue to work unchanged.
 */

// ---------------------------------------------------------------------------
// Re-exports for consumer compatibility (callers import from "./services")
// ---------------------------------------------------------------------------

export type { RoutingPreset, UsageDimension, UsagePeriod } from "../../application/contracts";
export * from "../views";
export * from "../session";
export { MemoryRouteTransitionStore } from "../route-transitions";
export * from "../input-sanitizers";

// ---------------------------------------------------------------------------
// Imports for the service classes below
// ---------------------------------------------------------------------------

import type { ModelMetadataResolver } from "../../application/model-metadata";
import type { ProviderRegistry } from "../../providers/registry";
import { TokenRefreshPool, createAuthDriverRegistry, type AccountHealthManager, type AuthDriverRegistry } from "../../application/auth";
import { OAuthLoginSessionManager } from "../../application/auth";

// Re-import symbols used by service classes from the extracted modules.
import type { ConsoleRepositories } from "../views";
import type { LoginLimiter } from "../session";

import { ModelService } from "./models";
export { ModelService };
import { ProviderService } from "./providers";
import { AccountService, type AccountView } from "./accounts";
export { AccountService, type AccountView };
import { FilterRuleService, RoutingConfigService } from "./policies";
export { FilterRuleService, RoutingConfigService };
import { SettingsService, TelemetryService } from "./settings";
import { BackupService } from "./backup";
export { BackupService };
export { SettingsService, TelemetryService };
import { ProxyService, type ProxyView } from "./proxy";
export { ProxyService, type ProxyView };
import { WebSearchRoutingService, type WebSearchRoutingStatus } from "./web-search-routing";
export { WebSearchRoutingService, type WebSearchRoutingStatus };
export { ProviderService };


// ---------------------------------------------------------------------------
// Auth service result types
// ---------------------------------------------------------------------------
import { OAuthService, type OAuthAccountStatusView, type OAuthCompleteResultView, type OAuthRefreshResultView, type OAuthStartResultView } from "./oauth";
export { OAuthService, type OAuthAccountStatusView, type OAuthCompleteResultView, type OAuthRefreshResultView, type OAuthStartResultView };
import { QuotaService, type QuotaRefreshQueueStatus } from "./quota";
export { QuotaService, type QuotaRefreshQueueStatus };
import { AuthService, type AuthActionResult, type LoginResult } from "./auth";
export { AuthService, type AuthActionResult, type LoginResult };
import { ApiKeyService } from "./api-keys";
export { ApiKeyService };














export interface ConsoleServices {
  readonly auth: AuthService;
  readonly keys: ApiKeyService;
  readonly providers: ProviderService;
  readonly models: ModelService;
  readonly accounts: AccountService;
  readonly oauth: OAuthService;
  readonly proxies: ProxyService;
  readonly webSearchRouting: WebSearchRoutingService;
  readonly quota: QuotaService;
  readonly settings: SettingsService;
  readonly routing: RoutingConfigService;
  readonly filterRules: FilterRuleService;
  readonly backup: BackupService;
  readonly telemetry: TelemetryService;
}

export interface CreateConsoleServicesOptions {
  readonly repositories: ConsoleRepositories;
  readonly registry: ProviderRegistry;
  readonly loginLimiter?: LoginLimiter;
  /** Provider-id keyed OAuth drivers; defaults to the bundled drivers. */
  readonly authDrivers?: AuthDriverRegistry;
  /** Canonical model metadata resolution for model/alias/combo views. */
  readonly modelMetadata?: ModelMetadataResolver;
  /** Central account-level OAuth refresh pool shared by every caller. */
  readonly oauthCoordinator: TokenRefreshPool;
  /** Durable account health manager used for permanent OAuth invalidation. */
  readonly accountHealth?: AccountHealthManager;
}

export function createConsoleServices(options: CreateConsoleServicesOptions): ConsoleServices {
  const { repositories, registry, loginLimiter, modelMetadata, oauthCoordinator, accountHealth } = options;
  const authDrivers = options.authDrivers ?? createAuthDriverRegistry();
  const providerService = new ProviderService(registry, repositories.providerConfig, repositories.customProviders, repositories.accounts, authDrivers);
  const modelService = new ModelService(repositories.models, registry, modelMetadata);
  const accountService = new AccountService(repositories.accounts, repositories.transitions);
  const proxyService = new ProxyService(repositories.proxies, repositories.proxySettings, repositories.transitions);
  return {
    auth: new AuthService(repositories.settings, loginLimiter),
    keys: new ApiKeyService(repositories.keys),
    providers: providerService,
    models: modelService,
    accounts: accountService,
    oauth: new OAuthService({
      sessions: new OAuthLoginSessionManager({ drivers: authDrivers }),
      tokenRefresh: oauthCoordinator,
      drivers: authDrivers,
      accounts: repositories.accounts,
      tokens: repositories.oauthTokens,
    }),
    webSearchRouting: new WebSearchRoutingService(proxyService, providerService, modelService, accountService),
    proxies: proxyService,
    quota: new QuotaService(repositories.accounts, repositories.quotaState, repositories.oauthTokens, oauthCoordinator, accountHealth),
    settings: new SettingsService(repositories.settings),
    routing: new RoutingConfigService(repositories.routing, modelMetadata),
    filterRules: new FilterRuleService(repositories.filterRules),
    backup: new BackupService(repositories.settings, repositories.backup),
    telemetry: new TelemetryService(repositories.runtimeMetadata),
  };
}
