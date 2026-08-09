import { Database } from "bun:sqlite";
import type { RouteHealthStore } from "../../application/contracts";
import type { AccountHealthStore, CredentialConfigStore, ModelLockStore, OAuthTokenStore, QuotaStateStore } from "../../application/auth/credentials";
import type { ProxyPoolConfigStore } from "../../traffic/network";
import type { FilterRuleRepository, IpBanRepository } from "../../console/views";
import type { WarpAccountRepository } from "../../console/warp/types";
import { applyConfigRestore, exportConfigBackup, type BackupPayload, type RestoreResult, type RestoreValidation } from "./backup";
import { createConfigDatabase } from "./database";
import { getPersistenceEnv, type PersistenceEnv } from "./env";
import { clearAllDatabaseTables } from "./schema";
import type { AccessRuleRepository, AccountRepository, AliasRepository, ApiKeyRepository, CliModelMappingRepository, ComboRepository, CustomProviderRepository, HealthRepository, ProviderModelRepository, ProxyRepository, SettingsRepository, ShareLinkRepository } from "./records";
import { createAccountRepository } from "./repositories/accounts";
import { createApiKeyRepository } from "./repositories/api-keys";
import { createAccessRuleRepository, createCustomProviderRepository } from "./repositories/custom-providers";
import { createHealthRepository } from "./repositories/health";
import { createFilterRuleRepository, createIpBanRepository } from "./repositories/policies";
import { createProxyRepository } from "./repositories/proxies";
import { createAliasRepository, createCliModelMappingRepository, createComboRepository, createProviderModelRepository } from "./repositories/routing";
import { createSettingsRepository } from "./repositories/settings";
import { createShareLinkRepository } from "./repositories/share-links";
import { createWarpAccountRepository } from "./repositories/warp-accounts";
import { createDurableAccountHealthStore, createDurableCredentialConfigStore, createDurableModelLockStore, createDurableOAuthTokenStore, createDurableProxyPoolConfigStore, createDurableQuotaStateStore, createDurableRouteHealthStore } from "./stores";
export interface ConfigPersistence {
  readonly env: PersistenceEnv;
  readonly settings: SettingsRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly accounts: AccountRepository;
  readonly accountHealth: HealthRepository;
  readonly proxyHealth: HealthRepository;
  readonly proxies: ProxyRepository;
  readonly providerModels: ProviderModelRepository;
  readonly aliases: AliasRepository;
  readonly cliModelMappings: CliModelMappingRepository;
  readonly combos: ComboRepository;
  readonly customProviders: CustomProviderRepository;
  readonly accessRules: AccessRuleRepository;
  readonly shareLinks: ShareLinkRepository;
  readonly filterRules: FilterRuleRepository;
  readonly ipBans: IpBanRepository;
  readonly warpAccounts: WarpAccountRepository;
  readonly stores: {
    readonly routeHealth: RouteHealthStore;
    readonly accountHealth: AccountHealthStore;
    readonly quotaState: QuotaStateStore;
    readonly oauthToken: OAuthTokenStore;
    readonly credentialConfig: CredentialConfigStore;
    readonly proxyPool: ProxyPoolConfigStore;
    readonly modelLocks: ModelLockStore;
  };
  /** WAL checkpoint without blocking readers. */
  readonly checkpoint: () => void;
  /** Configuration snapshot export (secrets included — this is the backup file). */
  readonly backup: () => BackupPayload;
  /** Applies a pre-validated backup inside one transaction; rolls back on any error. */
  readonly restoreBackup: (validation: Extract<RestoreValidation, { ok: true }>) => RestoreResult;
  /** Destructive reset used only after console password confirmation. */
  readonly resetAll: () => void;
  /** Flushes coalesced writes and closes the connection. */
  readonly close: () => void;
  /**
   * Live `Database` handle for coordinated admin writes (db-map SQL console).
   * Exposed only because the database browser needs raw SQL access that the
   * repository boundary cannot express; never use this from request hot paths.
   */
  readonly db: () => Database;
  /**
   * Checkpoint and close the current connection so the live file can be
   * renamed/overwritten (db-map import). Unlike the terminal shutdown
   * `close()`, the singleton can be brought back with `reopen()`.
   */
  readonly closeForSwap: () => void;
  /**
   * Reopen a fresh connection at the same path so a swapped database file
   * (db-map import) is picked up by all repositories.
   */
  readonly reopen: () => void;
}

// ───────────────────── Filter rules ──────────────────────────────────────────



export function createConfigPersistence(env: PersistenceEnv = getPersistenceEnv()): ConfigPersistence {
  const database = createConfigDatabase(env);
  const getDb = database.getDb;

  const settingsRepo = createSettingsRepository(getDb, env);
  const apiKeysRepo = createApiKeyRepository(getDb);
  const accountsRepo = createAccountRepository(getDb);
  const accountHealthRepo = createHealthRepository(getDb, "provider_account_health", "account_id", "account");
  const proxyHealthRepo = createHealthRepository(getDb, "proxy_health", "proxy_id", "proxy");
  const proxiesRepo = createProxyRepository(getDb);
  const providerModelsRepo = createProviderModelRepository(getDb);
  const aliasesRepo = createAliasRepository(getDb);
  const cliModelMappingsRepo = createCliModelMappingRepository(getDb);
  const combosRepo = createComboRepository(getDb);
  const customProvidersRepo = createCustomProviderRepository(getDb);
  const accessRulesRepo = createAccessRuleRepository(getDb);
  const shareLinksRepo = createShareLinkRepository(getDb);
  const filterRulesRepo = createFilterRuleRepository(getDb);
  const ipBansRepo = createIpBanRepository(getDb);
  const warpAccountsRepo = createWarpAccountRepository(getDb);

  return {
    env,
    settings: settingsRepo,
    apiKeys: apiKeysRepo,
    accounts: accountsRepo,
    accountHealth: accountHealthRepo,
    proxyHealth: proxyHealthRepo,
    proxies: proxiesRepo,
    providerModels: providerModelsRepo,
    aliases: aliasesRepo,
    cliModelMappings: cliModelMappingsRepo,
    combos: combosRepo,
    customProviders: customProvidersRepo,
    accessRules: accessRulesRepo,
    shareLinks: shareLinksRepo,
    filterRules: filterRulesRepo,
    warpAccounts: warpAccountsRepo,
    ipBans: ipBansRepo,
    stores: {
      routeHealth: createDurableRouteHealthStore(getDb),
      accountHealth: createDurableAccountHealthStore(getDb),
      quotaState: createDurableQuotaStateStore(getDb),
      oauthToken: createDurableOAuthTokenStore(getDb),
      credentialConfig: createDurableCredentialConfigStore(getDb),
      proxyPool: createDurableProxyPoolConfigStore(getDb),
      modelLocks: createDurableModelLockStore(getDb),
    },
    checkpoint: database.checkpoint,
    db: getDb,
    closeForSwap(): void {
      apiKeysRepo.flushTouches();
      database.closeForSwap();
    },
    reopen: database.reopen,
    backup(): BackupPayload {
      return exportConfigBackup(getDb());
    },
    restoreBackup(validation: Extract<RestoreValidation, { ok: true }>): RestoreResult {
      return applyConfigRestore(getDb(), validation);
    },
    resetAll(): void {
      const database = getDb();
      clearAllDatabaseTables(database);
      settingsRepo.ensure();
    },
    close(): void {
      apiKeysRepo.flushTouches();
      database.close();
    },
  };
}

let singleton: ConfigPersistence | null = null;

/** Test-only: close the singleton so the next access re-opens (possibly at a re-pointed env). */
export function resetConfigPersistenceForTests(): void {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // already closed — fine
    }
    singleton = null;
  }
}

