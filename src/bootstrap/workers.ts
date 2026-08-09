import {
  AnthropicOAuthDriver,
  AntigravityOAuthDriver,
  ClineOAuthDriver,
  ClinePassOAuthDriver,
  createAuthDriverRegistry,
  createDriverAwareOAuthRefresher,
  createEnvOAuthRefresher,
  CredentialSelector,
  type CredentialConfigStore,
  GrokBuildOAuthDriver,
  KimchiOAuthDriver,
  KiroOAuthDriver,
  QuotaRefreshWorker,
  type QuotaStateStore,
  TokenRefreshPool,
  type AccountHealthManager,
} from "../application/auth";
import type { ApplicationLogger } from "../console/logger";
import type { ConfigPersistence } from "../storage";
import { AccountRecoverySweep } from "../application/recovery-sweep";
import type { ProviderRegistry } from "../providers/registry";

export interface OAuthRuntimeDependencies {
  readonly config: ConfigPersistence;
  readonly logger: ApplicationLogger;
}

/** Builds the provider OAuth registry and the shared token refresh coordinator. */
export function createOAuthRuntime({ config, logger }: OAuthRuntimeDependencies) {
  const authDrivers = createAuthDriverRegistry([
    { providerId: "kiro", driver: new KiroOAuthDriver() },
    { providerId: "antigravity", driver: new AntigravityOAuthDriver() },
    { providerId: "claude", driver: new AnthropicOAuthDriver() },
    { providerId: "cline", driver: new ClineOAuthDriver() },
    { providerId: "clinepass", driver: new ClinePassOAuthDriver() },
    { providerId: "kimchi", driver: new KimchiOAuthDriver() },
    { providerId: "grok-build", driver: new GrokBuildOAuthDriver() },
  ]);
  const credentialStore = config.stores.credentialConfig;
  const resolveProvider = async (accountId: string): Promise<string | null> => config.accounts.get(accountId)?.provider ?? (await credentialStore.getAccount(accountId))?.providerId ?? null;
  const oauthRefresher = createDriverAwareOAuthRefresher({
    drivers: authDrivers,
    resolveProvider,
    fallback: createEnvOAuthRefresher({ resolveProvider }),
  });
  const oauth = new TokenRefreshPool(credentialStore, config.stores.oauthToken, oauthRefresher, {
    defaultPolicy: { refreshLeadMs: 5 * 60_000 },
    resolvePolicy: (account) => {
      const maxRefreshAgeMs: Record<string, number> = {
        codex: 2 * 24 * 60 * 60_000,
        claude: 4 * 60 * 60_000,
        antigravity: 5 * 60_000,
        "grok-build": 5 * 60_000,
        kiro: 15 * 60_000,
        cline: 30 * 60_000,
        clinepass: 30 * 60_000,
        kimchi: 5 * 60_000,
      };
      return { refreshLeadMs: 5 * 60_000, maxRefreshAgeMs: maxRefreshAgeMs[account.providerId] };
    },
    onRefreshed: (accountId) => logger.system("info", "oauth-refresh", `OAuth token refreshed for account ${accountId}`),
    onFailed: (accountId, error) => logger.system("warn", "oauth-refresh", `OAuth refresh failed for account ${accountId}: ${error.kind}`),
  });
  return { authDrivers, credentialStore, oauth, accounts: new CredentialSelector(credentialStore, oauth) };
}


export interface QuotaRefreshWorkerDependencies {
  readonly credentialStore: CredentialConfigStore;
  readonly quotaState: QuotaStateStore;
  readonly refreshQuota: (accountId: string) => Promise<boolean>;
  readonly labelAccount: (accountId: string) => Promise<string>;
  readonly logger: ApplicationLogger;
}

/** Creates the periodic quota refresh worker and its observable lifecycle logs. */
export function createQuotaRefreshWorker({ credentialStore, quotaState, refreshQuota, labelAccount, logger }: QuotaRefreshWorkerDependencies): QuotaRefreshWorker {
  return new QuotaRefreshWorker(credentialStore, quotaState, refreshQuota, {
    onRefreshed: (accountId, quotaAvailable) => {
      void labelAccount(accountId).then((label) => logger.system("info", "quota-refresh", `Quota Refreshed for ${label}: available=${quotaAvailable}`));
    },
    onFailed: (accountId) => {
      void labelAccount(accountId).then((label) => logger.system("warn", "quota-refresh", `Quota Refresh Failed for ${label}`));
    },
  });
}

/** Creates the bounded account recovery sweep using the durable route-health stores. */
export function createAccountRecoverySweep(accountHealth: AccountHealthManager, config: ConfigPersistence): AccountRecoverySweep {
  return new AccountRecoverySweep(accountHealth, config.stores.modelLocks);
}

/** Resolves the safe human-readable account label used by quota worker logs. */
export function createQuotaAccountLabel(config: ConfigPersistence, registry: ProviderRegistry): (accountId: string) => Promise<string> {
  return async (accountId) => {
    const account = config.accounts.get(accountId);
    const stored = await config.stores.credentialConfig.getAccount(accountId);
    let identity = account?.name ?? accountId;
    if (typeof stored?.secret === "string" && stored.secret.startsWith("{")) {
      try {
        const parsed = JSON.parse(stored.secret) as Record<string, unknown>;
        if (typeof parsed.email === "string" && parsed.email.length > 0) identity = parsed.email;
      } catch {
        // Keep the configured account name for malformed credential bundles.
      }
    }
    const providerId = account?.provider ?? stored?.providerId ?? "unknown";
    const provider = providerId === "codex" ? "Codex" : registry.get(providerId)?.metadata.displayName ?? providerId;
    return `{${provider}} Account @${identity}`;
  };
}