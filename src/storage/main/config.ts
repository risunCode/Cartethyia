// Re-export schema + records so existing consumers importing from "./config"
export { createDurableAccountHealthStore, createDurableCredentialConfigStore, createDurableModelLockStore, createDurableOAuthTokenStore, createDurableProxyPoolConfigStore, createDurableQuotaStateStore, createDurableRouteHealthStore } from "./stores";
export { createConfigPersistence, resetConfigPersistenceForTests } from "./persistence";
export type { ConfigPersistence } from "./persistence";
// continue to work unchanged.
export {
  CONFIG_SCHEMA_SQL,
  clearAllDatabaseTables,
  nowIso,
  configError,
  toRouteStatus,
  toErrorKind,
  orNullString,
} from "./schema";
export type {
  SettingsRecord,
  RuntimeSettings,
  ApiKeyPublic,
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  ProviderAccountRecord,
  AccountCreateInput,
  AccountPatchInput,
  AccountListPagination,
  AccountListPage,
  ProxyRecord,
  ProxyCreateInput,
  ProxyTestRecordInput,
  ProxyPatchInput,
  ProxySettingsRecord,
  ProviderModelRecord,
  AliasRecord,
  CliModelMappingRecord,
  CliMappingSettingsRecord,
  ComboRecord,
  CustomProviderRecord,
  AccessRuleRecord,
  SettingsRepository,
  ApiKeyRepository,
  AccountRepository,
  HealthRepository,
  ProxyRepository,
  ProviderModelRepository,
  AliasRepository,
  CliModelMappingRepository,
  ComboRepository,
  CustomProviderRepository,
  AccessRuleRepository,
  ShareLinkRecord,
  ShareLinkRepository,
} from "./records";
export { credentialKindOf } from "./mappers";

