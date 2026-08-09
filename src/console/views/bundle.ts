import type { SettingsRepository } from "./settings";
import type { ApiKeyRepository } from "./api-keys";
import type { ProviderConfigRepository, CustomProviderRepository } from "./providers";
import type { ModelRepository } from "./models";
import type { AccountRepository } from "./accounts";
import type { ProxyRepository, ProxySettingsRepository } from "./proxies";
import type { RoutingConfigRepository } from "./routing";
import type { FilterRuleRepository } from "./policies";
import type { RuntimeMetadataRepository } from "./telemetry";
import type { BackupRepository } from "./backup";
import type { RouteTransitionStore } from "./transitions";
import type { OAuthTokenStore, QuotaStateStore } from "../../application/auth/credentials";
import type { ModelMetadataResolver, ResolvedModelMetadata } from "../../application/model-metadata";

// ---------------------------------------------------------------------------
// Repository bundle
// ---------------------------------------------------------------------------

export interface ConsoleRepositories {
  readonly settings: SettingsRepository;
  readonly keys: ApiKeyRepository;
  readonly providerConfig: ProviderConfigRepository;
  readonly customProviders: CustomProviderRepository;
  readonly models: ModelRepository;
  readonly accounts: AccountRepository;
  /** Durable OAuth token persistence (current main storage, `provider_accounts.credential`). */
  readonly oauthTokens: OAuthTokenStore;
  /** Durable normalized quota snapshots and refresh timestamps. */
  readonly quotaState: QuotaStateStore;
  readonly proxies: ProxyRepository;
  readonly proxySettings: ProxySettingsRepository;
  readonly routing: RoutingConfigRepository;
  readonly filterRules: FilterRuleRepository;
  readonly backup: BackupRepository;
  readonly runtimeMetadata: RuntimeMetadataRepository;
  readonly transitions: RouteTransitionStore;
}

// Re-export model metadata resolver for callers that previously reached it via services.
export type { ModelMetadataResolver, ResolvedModelMetadata };