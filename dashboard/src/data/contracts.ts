import type { healthStatus } from "../../../src/persistence/schema";
import type { SessionStatusResponse } from "../../../src/console/auth/session";
/**
 * Type-only projections of the console API contracts.
 *
 * These exports deliberately point at the existing backend contract modules; the
 * dashboard does not define a second set of endpoint request or response types.
 */
// `USAGE_DIMENSIONS` is re-exported as a value (not a type-only import) because
// the Usage page validates the `?dim=` query parameter against it at runtime.
// It comes from the pure `usage-dimensions` module rather than
// `observability/contracts`, which imports Elysia and reaches `node:crypto` through the
// error path — re-exporting from there put a Node builtin in the browser bundle.
export { USAGE_DIMENSIONS } from "../../../src/console/observability/usage-dimensions";
export type { UsageDimension } from "../../../src/console/observability/usage-dimensions";
// `TENANT_KEY_SCOPES` is re-exported as a value so the API-key editor renders
// the backend's own assignable-scope list instead of a hand-kept copy. The
// module is pure (no imports), so it is safe in the browser bundle.
export { TENANT_KEY_SCOPES } from "../../../src/security/access-control";
export type { TenantScope } from "../../../src/security/access-control";
// Share-popup image bounds are re-exported as values (like `TENANT_KEY_SCOPES`)
// so the upload control rejects the same formats and size the backend does.
// The module is pure (no imports), so it is safe in the browser bundle.
export {
  SHARE_POPUP_IMAGE_MAX_BYTES,
  SHARE_POPUP_IMAGE_MIMES,
} from "../../../src/console/domains/api-keys/share-popup-image";
// `CLIENT_ROUTER_IDS` is re-exported so the API-key editor offers exactly the
// routers the backend can fingerprint, instead of a hand-kept copy that would
// let the form offer an id the backend rejects. The module is pure (no imports),
// so it is safe in the browser bundle.
export {
  CLIENT_ROUTER_IDS,
  CLIENT_ROUTERS,
  normalizeClientRouterId,
} from "../../../src/security/client-router-fingerprint";

export type {
  SystemHealthResponse,
  UsageByResponse,
  UsageByRow,
  UsageChartResponse,
  UsageRequestDetail,
  UsageRequestItem,
  UsageRequestsResponse,
  UsageSummaryResponse,
  UsageSummaryTotals,
} from "../../../src/console/observability/contracts";

export type {
  AccountInflightReading,
  ProviderResponse,
  CreateProviderRequest,
  UpdateProviderRequest,
  ModelCatalogResponse,
  ModelCatalogEntry,
  FlatModelCatalogEntry,
  OAuthDevicePollResponse,
  ProviderRoutingResponse,
  UpdateProviderRoutingRequest,
  CreateProviderAccountRequest,
  UpdateProviderAccountRequest,
  ProviderAccountResponse,
  ProviderAccountExport,
  ProviderAccountsExportResponse,
  ProbeAllAccountsResult,
  ProbeModelRequest,
  ProbeModelResult,
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  SetModelEnabledRequest,
} from "../../../src/console/providers/catalog/contracts";

export type { AccountHealthEventRecord } from "../../../src/providers/operations/account-health-service";

/**
 * Reasoning efforts the probe accepts, as the backend declares them. Re-exported
 * as a value (like `TENANT_KEY_SCOPES`) so the Thinking selector and the route
 * schema cannot drift: `auto` is a member, and it means "send no reasoning
 * intent" rather than a specific effort.
 */
export { PROBE_REASONING_EFFORTS } from "../../../src/providers/discovery/discovery-types";
export type { ProbeReasoningEffort } from "../../../src/providers/discovery/discovery-types";

/**
 * The `model(level)` naming rule, re-exported from the backend parser so the
 * dashboard renders exactly the id a client should send. A hand-written
 * `(level)` string here would drift from `parseThinkingSuffix` the moment
 * either side changes.
 *
 * `resolveSupportedReasoningEfforts` and `clampReasoningEffort` ride along for
 * the same reason: the picker has to show the ladder a model will actually
 * honor and the level a request will actually land on, and the only way to
 * guarantee that is to ask the functions dispatch asks. A hand-rolled ladder in
 * the dashboard would disagree with the router the first time a model is added.
 */
export {
  clampReasoningEffort,
  formatThinkingSuffix,
  resolveSupportedReasoningEfforts,
} from "../../../src/transport/translation/thinking";
export type { ReasoningEffortLevel } from "../../../src/transport/translation/thinking";

export type {
  ComboStrategy,
  ModelAliasRow,
  ModelAliasCreateInput,
  ModelAliasPatchInput,
  ModelComboRow,
  ModelComboCreateInput,
  ModelComboPatchInput,
  ModelComboCloneResult,
} from "../../../src/console/routing/model/contracts";

export type {
  CreateApiKeyRequest,
  ApiKeyResponse,
  CreateApiKeyResponse,
  UpdateApiKeyResponse,
  ShareKeyResponse,
} from "../../../src/console/domains/api-keys/contracts";

// Model-abuse bans are a platform-admin, cross-tenant list (`GET`/`DELETE
// /model-bans`). The row shape is the backend's own, so the dashboard never
// keeps a second copy of the fields the unban call is keyed on.
export type { ModelAbuseBan } from "../../../src/security/model-abuse";
export type {
  SharedKeySummary,
  SharedKeyActivityDetail,
  SharedKeyModelUsage,
  SharedKeyRequestEvent,
} from "../../../src/console/share/share-usage";

// Backup export returns the payload itself (it is the file the operator
// downloads); import returns the per-table counts plus the router-import
// report, so the page can show what was skipped and why.
export type { BackupPayload as BackupExportResponse } from "../../../src/console/backup/contracts";
export type { ImportResult as BackupImportResponse } from "../../../src/console/backup/service";
export type { ImportReport as BackupImportReport } from "../../../src/console/backup/nine-router";

export type { AuditEntry, AuditListPage } from "../../../src/console/domains/audit/contracts";

export type {
  StudioMessage,
  StudioAttachment,
  StudioMediaResult,
  StudioSessionView,
  StudioSessionSummary,
} from "../../../src/console/domains/studio/contracts";

export type {
  RuntimeSettingsResponse,
  UpdateRuntimeSettingsRequest,
} from "../../../src/console/settings/contracts";

export type { RedisMode } from "../../../src/persistence/readiness";

export type HealthStatus = (typeof healthStatus.enumValues)[number];

/**
 * The dashboard's session view: the wire `SessionStatusResponse`, narrowed to
 * its authenticated arm and renamed to the dashboard's camelCase convention.
 * Derived from the backend type rather than hand-written — the previous mirror
 * dropped `username` and made `display_name`/`is_first_boot`/
 * `session_expires_at` required, and nothing compared the two.
 */
export type SessionResponse = SessionStatusResponse;

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly isFirstBoot: boolean;
  readonly sessionExpiresAt: string;
  readonly isPlatformAdmin: boolean;
}

// Speed-test payload bounds are re-exported as values (like `TENANT_KEY_SCOPES`)
// so the size picker offers exactly what the backend accepts. They come from a
// pure module; the pool type contracts are Elysia-free too (routes.ts is the
// only pool module that touches the HTTP layer).
export {
  SPEED_TEST_DEFAULT_BYTES,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_MIN_BYTES,
} from "../../../src/console/routing/pools/speed-test-sizes";
export type {
  CreateNetworkPoolRequest,
  NetworkPoolResponse,
  HealthCheckResult,
  PoolSpeedTestResult,
  PoolStrategySetting,
  PoolBatchProbeResult,
} from "../../../src/console/routing/pools/contracts";
export type {
  RelayDeployRequest,
  RelayDeployResult,
  RelayTarget,
} from "../../../src/console/routing/pools/relay-deploy";
export { RELAY_TARGETS } from "../../../src/console/routing/pools/relay-deploy";
export type { PoolHealthEvent } from "../../../src/network/pool-health-machine";


export type {
  ToolDef,
  ToolRegistryEntry,
  ToolStatus,
  ApplyInput,
  ApplyConfigResult,
  DownloadResult,
  CliMappingInput,
  CliMappingSettings,
} from "../../../src/console/cli-tools/contracts";
