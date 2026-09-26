// Provider catalog contracts: the provider/account/model DTOs, the persistence
// boundary, and the compatibility-profile validator shared by the catalog
// routes and the Drizzle catalog store.

import { GatewayError } from "../../../transport/gateway-error";
import { type WireFamily, WIRE_FAMILIES } from "../../../transport/canonical-model";
import { type ProviderRoutingSetting, type ProviderRoutingStrategy } from "../../../transport/routing/route-model";
import { isProtectedHeader } from "../../../security/outbound-headers";
import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import type { CompatibilityProfile } from "../../../providers/provider-metadata";
import type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
} from "../../../providers/discovery/discovery-types";

/**
 * Credential kinds a provider account may carry, as a runtime tuple. The
 * create/update request types and the catalog route's Elysia schema both
 * project it.
 */
export const CREDENTIAL_KINDS = ["api_key", "oauth", "none"] as const;

/** One credential kind. */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export const PROVIDER_ROUTING_MAX_INFLIGHT_BOUNDS = { min: 1, max: 10_000 } as const;

/**
 * Scopes that grant catalog access, one pair per resource.
 *
 * Two principals reach these routes and their vocabularies differ: a browser
 * session holds `dashboard:*`, a tenant API key is granted `providers:*` /
 * `models:*`. Keeping both pairs here — rather than at each call site — means a
 * route cannot accidentally accept one principal and lock out the other, and
 * the read/write split is stated once.
 *
 * The catalog scopes stand alone, and that is the point: `dashboard:write` is
 * *not* in these lists. It is a scope a tenant API key can hold, and a key
 * minted to change a display setting must not thereby be able to add an
 * upstream or delete a model — those writes change where traffic goes and which
 * credentials are used. The browser session is granted the catalog scopes
 * explicitly (see `resolveConsoleAccess`) because it is the operator, so the
 * dashboard keeps working without widening what `dashboard:write` means.
 */
export const PROVIDER_READ_SCOPES = ["providers:read"] as const;
export const PROVIDER_WRITE_SCOPES = ["providers:write"] as const;
export const MODEL_READ_SCOPES = ["models:read"] as const;
export const MODEL_WRITE_SCOPES = ["models:write"] as const;

/**
 * Account enable/disable states an operator may set, as a runtime tuple.
 * `degraded` and `cooldown` are health-machine-only and deliberately absent.
 */
export const ACCOUNT_STATUSES = ["active", "disabled"] as const;

/** One operator-settable account status. */
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

const VALID_WIRE_FAMILIES: Record<WireFamily, true> = {
  chat: true,
  responses: true,
  messages: true,
};

export function isWireFamily(value: unknown): value is WireFamily {
  return typeof value === "string" && value in VALID_WIRE_FAMILIES;
}

/**
 * Compile-time guard: `VALID_WIRE_FAMILIES` above must cover `WIRE_FAMILIES`
 * exactly, so adding a family to the canonical tuple cannot leave the
 * validator silently rejecting it.
 */
const _wireFamilyCoverage: Record<(typeof WIRE_FAMILIES)[number], true> = VALID_WIRE_FAMILIES;
void _wireFamilyCoverage;

const TOKEN_REGEX = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;

const ADAPTER_OWNED: Record<string, true> = {
  "x-stainless-arch": true,
  "x-stainless-os": true,
  "x-account-id": true,
  "x-device-id": true,
  "x-session-id": true,
  "anthropic-version": true,
  "anthropic-beta": true,
  "x-app": true,
  originator: true,
  "chatgpt-account-id": true,
  "openai-beta": true,
};

export function validateCompatibilityProfile(profile: CompatibilityProfile): void {
  if (profile.credentialUrl !== undefined) {
    // credentialUrl is presentation-only, but we allow it; just ensure it's a string URL if present
    if (typeof profile.credentialUrl !== "string") {
      throw new GatewayError("invalid_request", 400, "credentialUrl must be string");
    }
  }
  if (profile.cli_identity !== undefined) {
    if (typeof profile.cli_identity !== "boolean") {
      throw new GatewayError("invalid_request", 400, "cli_identity must be boolean");
    }
  }
  if (profile.gateway_user_agent !== undefined) {
    if (typeof profile.gateway_user_agent !== "boolean") {
      throw new GatewayError("invalid_request", 400, "gateway_user_agent must be boolean");
    }
  }
  if (profile.extra_headers) {
    for (const [rawName, rawValue] of Object.entries(profile.extra_headers)) {
      const name = rawName.toLowerCase();
      if (name.length < 1 || name.length > 64 || !TOKEN_REGEX.test(name)) {
        throw new GatewayError("invalid_request", 400, `invalid header name ${rawName}`);
      }
      if (isProtectedHeader(name, ADAPTER_OWNED)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `header ${rawName} is not allowed as custom header`,
        );
      }
      if (typeof rawValue !== "string") {
        throw new GatewayError(
          "invalid_request",
          400,
          `header value for ${rawName} must be string`,
        );
      }
      if (Buffer.byteLength(rawValue, "utf8") > 4096) {
        throw new GatewayError("invalid_request", 400, `header value for ${rawName} exceeds 4KiB`);
      }
      if (/[\r\n\x00-\x1f\x7f]/.test(rawValue)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `header value for ${rawName} contains control characters`,
        );
      }
    }
  }
  if (profile.extra_query_params) {
    for (const [k, v] of Object.entries(profile.extra_query_params)) {
      if (typeof v !== "string")
        throw new GatewayError("invalid_request", 400, `query param ${k} must be string`);
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v))
        throw new GatewayError("invalid_request", 400, `query param contains CRLF`);
    }
  }
  if (profile.endpoint_paths_by_wire_family) {
    for (const [wf, path] of Object.entries(profile.endpoint_paths_by_wire_family)) {
      if (!isWireFamily(wf)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family: unknown wire family ${wf}`,
        );
      }
      if (typeof path !== "string") {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} must be string`,
        );
      }
      if (path.length === 0 || path.length > 256) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path length must be 1-256 chars`,
        );
      }
      if (!path.startsWith("/")) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path must start with /`,
        );
      }
      if (/[\s\r\n\x00-\x1f\x7f]/.test(path)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path contains invalid characters`,
        );
      }
    }
  }
  if (profile.model_wire_families) {
    if (!Array.isArray(profile.model_wire_families)) {
      throw new GatewayError("invalid_request", 400, "model_wire_families must be an array");
    }
    for (const rule of profile.model_wire_families) {
      if (typeof rule?.pattern !== "string" || rule.pattern.length === 0) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model_wire_families[].pattern must be a non-empty string",
        );
      }
      if (rule.pattern.length > 256) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model_wire_families[].pattern must be at most 256 chars",
        );
      }
      try {
        new RegExp(rule.pattern);
      } catch {
        throw new GatewayError(
          "invalid_request",
          400,
          `model_wire_families[].pattern ${rule.pattern} is not a valid regular expression`,
        );
      }
      if (!isWireFamily(rule.wire_family)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `model_wire_families[].wire_family: unknown wire family ${String(rule.wire_family)}`,
        );
      }
    }
  }
  if (
    profile.streaming_usage_mode &&
    !["include_usage", "none"].includes(profile.streaming_usage_mode)
  ) {
    throw new GatewayError("invalid_request", 400, "invalid streaming_usage_mode");
  }
  if (profile.structured_output && typeof profile.structured_output.enabled !== "boolean") {
    throw new GatewayError("invalid_request", 400, "structured_output.enabled must be boolean");
  }
  // If any field is present but has no runtime reader, our current reader set covers all fields above.
  const allowed: Record<string, true> = {
    extra_headers: true,
    extra_query_params: true,
    endpoint_paths_by_wire_family: true,
    // Read by `resolveCustomCliHeaders` in provider-catalog-service: a custom
    // provider's BYOK adapter stamps official CLI identity headers unless the
    // operator opts out. Omitting it here rejected every create/update that
    // carried the flag the dashboard always sends.
    cli_identity: true,
    // Explicit gateway-identity opt-in for BYOK rows (mirrors
    // `ApiKeyProviderSpec.gatewayUserAgent` for bundled specs).
    gateway_user_agent: true,
  };
  for (const k of Object.keys(profile)) {
    if (!allowed[k]) {
      throw new GatewayError(
        "invalid_request",
        400,
        `unknown compatibility_profile field ${k} has no runtime reader`,
      );
    }
  }
}

export interface CreateProviderRequest {
  providerId: string;
  label?: string;
  enabled?: boolean;
  capabilityProfile?: Record<string, unknown>;
  wireFamily?: string;
  baseUrl?: string;
  compatibilityProfile?: CompatibilityProfile;
  /** BYOK-only: model ids to register for this provider (one `models` row per entry). */
  models?: readonly string[];
}
export interface ModelCatalogResponse {
  modelId: string;
  route: string;
  provider: string;
}
export interface ModelCatalogEntry {
  modelId: string;
  route: string;
  provider: string;
  wireFamily: string;
  enabled: boolean;
  // Metadata (null = not yet enriched)
  contextLimit: number | null;
  outputLimit: number | null;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  /** Accepts PDF/plain-file input parts. */
  document: boolean;
  /** Accepts audio input parts. */
  audio: boolean;
  mediaGeneration: boolean;
  webSearch: boolean;
  cost: {
    input: number | null;
    output: number | null;
    cache_read?: number;
    pricing_model?: "pay-per-use" | "subscription" | "unknown";
  } | null;
  source: string | null;
  sourceUpdatedAt: string | null;
}
export interface FlatModelCatalogEntry {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly qualified: string;
  readonly entry: ModelCatalogEntry;
  /**
   * Where this entry came from. `model` rows are the default; `alias` and
   * `combo` are operator-defined routing targets that resolve to one or more
   * `model` rows at dispatch time. The picker renders all three.
   */
  readonly kind: "model" | "alias" | "combo";
}
/** Request accepted for a one-shot model connectivity test. `route`
 * disambiguates when a model id is registered under multiple endpoint
 * paths; omit it to probe against the model's already-registered wire
 * shape, or provide `wireFamily` to test a not-yet-registered candidate. */
export type { ProbeAllAccountsResult, ProbeAllModelsResult, ProbeModelRequest, ProbeModelResult };
export type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
} from "../../../providers/discovery/discovery-types";
export interface SetModelEnabledRequest {
  modelId: string;
  route: string;
  enabled: boolean;
}
/** Credential input accepted when provisioning a provider account. Never echoed back.
 * Concurrency is governed by Routing Strategy, not by an account field. */
export interface CreateProviderAccountRequest {
  label?: string;
  credentialKind: CredentialKind;
  secret: string;
}
/** Patch accepted when editing or revoking an existing account. */
export interface UpdateProviderAccountRequest {
  label?: string;
  secret?: string;
  status?: AccountStatus;
}
export interface ProviderAccountTokenUsage {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AccountInflightReading {
  readonly accountId: string;
  readonly inflight: number;
}

/** Public account representation; never carries the decrypted secret.
 * Effective concurrency comes from the provider Routing Strategy value, which
 * the route snapshot publishes to admission. This projection carries account
 * identity, status, and usage only. */
export interface ProviderAccountResponse {
  id: string;
  providerId: string;
  tenantId: string | null;
  label: string;
  credentialKind: CredentialKind;
  status: string;
  /** Live routing admission count for this request path; absent when unavailable. */
  inflight?: number;
  /** Token aggregates are tenant-scoped and use a UTC calendar day. */
  usageToday: ProviderAccountTokenUsage;
  usageAllTime: ProviderAccountTokenUsage;
  consecutiveFailures?: number;
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorCategory?: string;
  lastErrorAt?: string;
  cooldownUntil?: string;
  modelCooldowns?: Readonly<Record<string, string>>;
  lastRecoveredAt?: string;
  createdAt: string;
}
/**
 * Plaintext export of one account, including the decrypted credential.
 *
 * Deliberately distinct from `ProviderAccountResponse` (which never carries a
 * secret): only the export endpoint returns this shape, and the dashboard
 * downloads it as a JSON file rather than rendering it.
 */
export interface ProviderAccountExport {
  id: string;
  providerId: string;
  label: string;
  credentialKind: CredentialKind;
  status: string;
  /** Decrypted credential; `""` when the account has none or resolution failed. */
  secret: string;
  createdAt: string;
  /** Live routing admission count at export time; absent when unavailable. */
  inflight?: number;
  cooldownUntil?: string;
  lastErrorCategory?: string;
}
/** Response body of `POST /accounts/export`. */
export interface ProviderAccountsExportResponse {
  exportedAt: string;
  accounts: ProviderAccountExport[];
}
export interface UpdateProviderRequest {
  label?: string;
  enabled?: boolean;
  capabilityProfile?: Record<string, unknown>;
  baseUrl?: string;
  compatibilityProfile?: CompatibilityProfile;
}
export interface ProviderResponse {
  providerId: string;
  label?: string;
  enabled: boolean;
  isBuiltIn: boolean;
  /** True when this tenant has any persisted account for the provider. */
  configured?: boolean;
  /** `false` only for a genuinely credential-less provider (OpenCode Free) —
   * the dashboard hides account creation for it since none is usable. */
  requiresAccount: boolean;
  capabilityProfile?: Record<string, unknown>;
  baseUrl?: string;
  compatibilityProfile?: CompatibilityProfile;
  createdAt?: string;
  updatedAt?: string;
  /** Populated from the registered OAuth login clients — undefined means no live OAuth client. */
  oauthFlows?: { readonly browser: boolean; readonly device: boolean };
  /** Whether the provider supports dynamic model discovery. Custom providers always support it. */
  supportsModelDiscovery: boolean;
  /** Default wire family for this provider's models — the family the operator
   * chose when creating a custom provider. Absent means the column default. */
  wireFamilyDefault?: WireFamily;
  /** Wire families this provider may actually serve, derived from the registry
   * (built-ins) or the BYOK profile (custom). Absent means the provider
   * declares nothing and the caller's own choice stands. */
  supportedWireFamilies?: readonly WireFamily[];
}
export interface ProviderRecord extends ProviderResponse {
  tenantId: string | null;
}

export interface ProviderCatalogStore {
  list(tenantId: string): Promise<readonly ProviderRecord[]>;
  get(tenantId: string, providerId: string): Promise<ProviderRecord | undefined>;
  create(record: ProviderRecord): Promise<void>;
  update(
    tenantId: string,
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined>;
  delete(tenantId: string, providerId: string): Promise<boolean>;
  updateGlobal(
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined>;
  deleteGlobal(providerId: string): Promise<boolean>;
  listModels(tenantId: string, providerId: string): Promise<readonly ModelCatalogEntry[]>;
  /**
   * Every model row the tenant can see, grouped by provider id.
   *
   * The bulk counterpart to {@link listModels}: one query pair for the whole
   * tenant rather than one pair per provider, so a caller that needs the entire
   * catalog does not pay a cost that grows with the bundled provider count.
   * `providerId` narrows it to a single provider when the caller already knows
   * which one it wants.
   */
  listModelsForTenant(
    tenantId: string,
    providerId?: string,
  ): Promise<Map<string, readonly ModelCatalogEntry[]>>;
  probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult>;
  /**
   * Ad-hoc connectivity test for an operator-entered BYOK provider that is not
   * persisted yet, so the Add-Custom-Provider modal can validate the base URL
   * and API key before creating anything.
   */
  testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult>;
  probeAllModels(
    tenantId: string,
    providerId: string,
  ): Promise<ProbeAllModelsResult>;
  probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeAllAccountsResult>;
  setModelEnabled(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean>;
  deleteModel(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean>;
  /** BYOK-only: registers one `models` row per id for a just-created provider. */
  registerModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
    wireFamily?: string,
  ): Promise<void>;
  syncModels(tenantId: string, providerId: string): Promise<{ synced: number }>;
  listAccounts(tenantId: string, providerId: string): Promise<readonly ProviderAccountResponse[]>;
  listAllAccounts(tenantId: string): Promise<readonly ProviderAccountResponse[]>;
  createAccount(
    tenantId: string,
    providerId: string,
    request: CreateProviderAccountRequest,
  ): Promise<ProviderAccountResponse>;
  updateAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
    patch: UpdateProviderAccountRequest,
  ): Promise<ProviderAccountResponse | undefined>;
  listAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<readonly AccountHealthEventRecord[]>;
  recoverAccount(tenantId: string, providerId: string, accountId: string): Promise<boolean>;
}

/**
 * Console device-poll DTO: the browser-visible projection of the provider
 * device flow. Deliberately distinct from the provider-internal
 * `OAuthDevicePollResult` (`providers/auth/flows.ts`), which carries token
 * material that must never reach the dashboard — this shape carries only
 * the persisted account id. Dashboard imports this type; do not mirror it.
 */
export type OAuthDevicePollResponse =
  | { status: "pending" }
  | { status: "complete"; accountId: string }
  | { status: "failed"; reason: string };

export interface ProviderRoutingResponse {
  readonly providerId: string;
  readonly tenantId: string | null;
  readonly strategy: ProviderRoutingStrategy;
  /** Requests served by one account before round robin advances. */
  readonly rotateCount: number;
  /** Per-account inflight ceiling; `null` = unlimited concurrency. */
  readonly maxInflight: number | null;
  readonly enabled: boolean;
  /** When true, this provider's requests always dial direct. When false,
   * dispatch automatically picks the least-loaded, non-cooldown pool among
   * every active network pool the tenant owns — never an admin-pinned
   * single pool. Some providers (see `DEFAULT_PROXY_BYPASS_PROVIDER_IDS`)
   * default to bypass because their transport can't route through an HTTP
   * CONNECT proxy; it stays a real, per-tenant-overridable setting. */
  readonly bypassProxy: boolean;
}

/**
 * Patch accepted when editing a provider's routing settings. Every field is
 * optional and the types are the runtime's own: restating the six fields here
 * let the request drift from `ProviderRoutingSetting` (and from the Elysia body
 * schema that validates it) without a compile error.
 */
export type UpdateProviderRoutingRequest = Partial<ProviderRoutingSetting>;
