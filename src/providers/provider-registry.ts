// Provider contracts, registry, and credential resolution.

import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../transport/canonical-model";
import { GatewayError } from "../transport/gateway-error";
import type { BundledProviderId, CompatibilityProfile } from "./provider-metadata";
import type { OAuthLoginClient } from "./authentication/oauth-flow-store";
import type { OAuthTokenRefresher } from "./authentication/oauth-refresh-service";
import type { QuotaFetcher } from "./quota/quota-support";
import { unwrapProviderToken, type TokenEnvelope } from "./credential-envelope";
import { BUNDLED_PROVIDER_METADATA, DEFAULT_PROXY_BYPASS_PROVIDER_IDS, providerBaseUrl, providerJwtVerification, providerRequiresAccount, providerUpstreamHost, providerDefaultWireFamily } from "./provider-metadata";
import { metrics } from "../observability/metrics";
import { trackAdapterLoad } from "../observability/performance-metrics";
import type { ModelDefinition } from "./model-definition";
import type { ProviderModelDiscovery } from "./discovery/discovery-types";
export type { ModelCostDefinition, ModelDefinition } from "./model-definition";

/** Identity, adapter, model, OAuth, quota, and compatibility data for one provider. */
export interface ProviderModule {
  readonly id: BundledProviderId;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly upstreamHost: { readonly hostname: string; readonly port: number };
  readonly loadAuthentication?: () => Promise<ProviderAuthentication>;
  readonly loadQuotaCollector?: () => Promise<QuotaFetcher>;
  readonly loadModelDiscovery?: () => Promise<ProviderModelDiscovery>;
  readonly modelDiscoveryRequiresCredential?: boolean;
  readonly loadAdapter: () => Promise<ProviderAdapter>;
  /** Lazy model-catalog loader kept separate from heavy adapter modules. */
  readonly loadModels?: () => Promise<readonly ModelDefinition[]>;
  readonly endpointPathsByWireFamily?: Readonly<Partial<Record<WireFamily, string>>>;
  readonly compatibility?: CompatibilityProfile;
  readonly wireFamilyDefault: WireFamily;
  readonly requiresAccount: boolean;
  readonly defaultBypassProxy?: boolean;
}

/**
 * Derives a registry registration from a fully populated provider module.
 * Keeps the registration shape in one place so the default registry and any
 * future bundled modules use the same mapping.
 */
export function toRegistration(module: ProviderModule): ProviderRegistration {
  return {
    provider_id: module.id,
    load: module.loadAdapter,
    upstream_host: module.upstreamHost,
    ...(module.loadModels === undefined ? {} : { loadModels: module.loadModels }),
    ...(module.endpointPathsByWireFamily === undefined
      ? {}
      : { endpoint_paths_by_wire_family: module.endpointPathsByWireFamily }),
    ...(module.loadAuthentication === undefined ? {} : { loadAuthentication: module.loadAuthentication }),
    ...(module.loadQuotaCollector === undefined ? {} : { loadQuotaCollector: module.loadQuotaCollector }),
    ...(module.loadModelDiscovery === undefined ? {} : { loadModelDiscovery: module.loadModelDiscovery }),
    ...(module.modelDiscoveryRequiresCredential === undefined
      ? {}
      : { modelDiscoveryRequiresCredential: module.modelDiscoveryRequiresCredential }),
  };
}

export { DEFAULT_PROXY_BYPASS_PROVIDER_IDS, providerBaseUrl, providerJwtVerification, providerRequiresAccount, providerUpstreamHost, providerDefaultWireFamily };
export type { BundledProviderId, ProviderJwtVerification } from "./provider-metadata";

/**
 * Normalizes a provider slug, rejecting anything that is not one. Persisted
 * IDs are already canonical, so no alias mapping is applied: an unknown or
 * misspelled slug is a caller error.
 */
function normalizeProviderSlug(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(trimmed)) {
    throw new GatewayError("invalid_request", 400, "Provider ID must be a lowercase slug");
  }
  return trimmed;
}

/** Validates a provider ID slug, without resolving it against the builtin set. */
export function resolveProviderId(id: string): ProviderId {
  return normalizeProviderSlug(id) as ProviderId;
}

/**
 * Every adapter must report the id it was registered under. A mismatch means
 * the registry would dispatch requests to an adapter that believes it serves a
 * different provider, so it fails loudly at load time instead of routing wrong.
 */
function assertAdapterIdentity(expected: ProviderId, adapter: ProviderAdapter): void {
  if (adapter.provider_id === expected) return;
  // A registration/adapter mismatch is our own wiring defect, not a client
  // error: `invalid_request` would blame the caller and invite a byte-identical
  // retry. `internal_error` (500) says what is true — the gateway is
  // misconfigured and the request never had a chance.
  throw new GatewayError("internal_error", 500, "Loaded adapter ID does not match registration", {
    provider_id: expected,
    adapter_id: adapter.provider_id,
  });
}

/** Closed union of every shipped provider ID. */
export const BUNDLED_PROVIDER_IDS = BUNDLED_PROVIDER_METADATA.map((definition) => definition.id) as readonly BundledProviderId[];

/** Normalized builtin or validated custom provider identifier. */
declare const customProviderIdBrand: unique symbol;
export type CustomProviderId = string & { readonly [customProviderIdBrand]: true };
export type ProviderId = BundledProviderId | CustomProviderId;

/** Credential alternatives supported by the control-plane resolver. */
export type CredentialKind =
  "none" | "api_key" | "oauth" | "scoped_access_token" | "workload_identity";

/** Credential returned by control-plane resolution and consumed by adapters. */
export interface ResolvedCredential {
  readonly provider_id: ProviderId;
  readonly account_id?: string | undefined;
  readonly credential_kind: CredentialKind;
  readonly secret?: Uint8Array | undefined;
  /** Operator-configured outbound headers, filtered by the owning adapter. */
  readonly custom_headers?: Readonly<Record<string, string>> | undefined;
}

export function readCredentialSecret(credential: ResolvedCredential, errorMessage?: string): string {
  const raw = credential.secret ? new TextDecoder().decode(credential.secret).trim() : "";
  if (!raw) {
    throw new GatewayError(
      "authentication_failed",
      401,
      errorMessage ?? "Provider credential secret is missing or empty",
    );
  }
  return raw;
}

/** Fetch capability that validates DNS answers and redirects before each request. */
export type ValidatedOutboundFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Internal marker for gateway-initiated provider probes; never serialized upstream. */
export const CARTETHYIA_PROBE_MARKER = "Cartethyia-Probe" as const;

/** Context passed from routing to a provider adapter. */
export interface ProviderDispatchContext {
  readonly credential: ResolvedCredential;
  readonly deadline: number;
  readonly abort_signal: AbortSignal;
  readonly outbound_fetch?: ValidatedOutboundFetch | undefined;
  /** Internal origin marker for provider probes; adapters must not forward it. */
  readonly probe_marker?: typeof CARTETHYIA_PROBE_MARKER;
  /** Original inbound headers needed only for provider-specific negotiation. */
  readonly request_headers?: Readonly<Record<string, string>> | undefined;
}

/** ProviderDispatchTarget identity already resolved by routing before credential leasing. */
export interface ProviderDispatchTarget {
  readonly provider_id: ProviderId;
  readonly model_id: string;
  readonly wire_family: WireFamily;
  readonly endpoint_path: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

/** Provider adapter boundary: canonical request/events in, no public HTTP routes. */
export interface ProviderAdapter {
  readonly provider_id: ProviderId;
  dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent>;
}

/**
 * Cost fields for one model. `pricing_model: "subscription"` means the
 * model is billed via a flat plan (no meaningful per-token input/output
 * figures) — both `input`/`output` stay `null` in that case.
 */
/**
 * One provider registration: identity, lazy adapter loader, and metadata.
 * `upstream_host` is the SSRF-validated network-binding target for this
 * provider — carried on the same registration object as the adapter loader
 * so adding a provider touches one call-site instead of a second map kept
 * in sync by hand elsewhere (`transport/dispatch/proxy-request.ts` used to hardcode this
 * separately; `providers/operations/provider-catalog-service.ts` now derives it from here).
 */
export interface ProviderRegistration {
  readonly provider_id: ProviderId;
  readonly load: () => Promise<ProviderAdapter>;
  readonly upstream_host?: { readonly hostname: string; readonly port: number };
  readonly loadModels?: () => Promise<readonly ModelDefinition[]>;
  readonly endpoint_paths_by_wire_family?: Readonly<Partial<Record<WireFamily, string>>>;
  readonly loadAuthentication?: () => Promise<ProviderAuthentication>;
  readonly loadQuotaCollector?: () => Promise<QuotaFetcher>;
  readonly loadModelDiscovery?: () => Promise<ProviderModelDiscovery>;
  readonly modelDiscoveryRequiresCredential?: boolean;
}

/** Authentication capabilities exposed by one provider integration. */
export interface ProviderAuthentication {
  readonly client?: OAuthLoginClient;
  readonly refresher?: OAuthTokenRefresher;
}

/** Returns true for one of Cartethyia's reserved builtin IDs, case-insensitively. */
export function isBundledProviderId(value: string): value is BundledProviderId {
  const normalized = value.trim().toLowerCase();
  return (BUNDLED_PROVIDER_IDS as readonly string[]).includes(normalized);
}

/** Normalizes a provider identifier before persistence or registry lookup. */
export function parseProviderId(value: string): ProviderId {
  const normalized = normalizeProviderSlug(value);
  return isBundledProviderId(normalized) ? normalized : normalized as CustomProviderId;
}

/**
 * Validates a custom/BYOK slug before any provider row is written.
 * Builtin collisions are case-insensitive and fail with typed `slug_reserved`.
 */
export function parseCustomProviderId(value: string): CustomProviderId {
  const normalized = parseProviderId(value);
  if (isBundledProviderId(normalized)) {
    throw new GatewayError(
      "slug_reserved",
      409,
      "The provider ID is reserved for a builtin provider",
      { provider_id: normalized },
    );
  }
  return normalized as CustomProviderId;
}


// Registry

/** Result of loading the configured provider registrations. */
export interface ProviderRegistrySnapshot {
  readonly revision: number;
  readonly adapters: ReadonlyMap<ProviderId, ProviderAdapter>;
}

/**
 * Single provider-registration authority. Every registration loads on
 * demand through its own loader; registrations that are not added are
 * simply absent.
 */
export class ProviderRegistry {
  #registrations = new Map<ProviderId, ProviderRegistration>();
  #loaded = new Map<ProviderId, ProviderAdapter>();
  #loading = new Map<ProviderId, Promise<ProviderAdapter>>();
  #authentication = new Map<ProviderId, ProviderAuthentication>();
  #authenticationLoading = new Map<ProviderId, Promise<ProviderAuthentication>>();
  #quotaCollectors = new Map<ProviderId, QuotaFetcher>();
  #quotaLoading = new Map<ProviderId, Promise<QuotaFetcher>>();
  #modelDiscovery = new Map<ProviderId, ProviderModelDiscovery>();
  #modelDiscoveryLoading = new Map<ProviderId, Promise<ProviderModelDiscovery>>();
  #revision = 0;

  /** Adds one registration and rejects duplicate canonical IDs. */
  register(registration: ProviderRegistration): void {
    const providerId = parseProviderId(registration.provider_id);
    if (this.#registrations.has(providerId)) {
      throw new GatewayError("invalid_request", 409, "Provider is already registered", {
        provider_id: providerId,
      });
    }
    if (providerId !== registration.provider_id) {
      throw new GatewayError("internal_error", 500, "Provider registration ID is not normalized", {
        provider_id: registration.provider_id,
      });
    }
    this.#registrations.set(providerId, registration);
    this.#revision += 1;
  }
  /** Removes one registration and any cached adapter/auth/quota/discovery state. */
  unregister(providerId: string): boolean {
    const normalized = parseProviderId(providerId);
    const removed = this.#registrations.delete(normalized);
    this.#loaded.delete(normalized);
    this.#authentication.delete(normalized);
    this.#quotaCollectors.delete(normalized);
    this.#modelDiscovery.delete(normalized);
    if (removed) this.#revision += 1;
    return removed;
  }

  /**
   * Registers one provider, replacing any existing registration for the same
   * id. Unlike {@link register} this never throws on a pre-existing entry:
   * console mutations re-apply a BYOK row after every edit (base URL,
   * compatibility profile), and a plain `register` would reject the second
   * write with 409. A replaced registration also drops its cached adapter so
   * the next `resolve` builds one from the new config.
   * @returns true when an existing registration was replaced.
   */
  upsert(registration: ProviderRegistration): boolean {
    const providerId = parseProviderId(registration.provider_id);
    if (providerId !== registration.provider_id) {
      throw new GatewayError("internal_error", 500, "Provider registration ID is not normalized", {
        provider_id: registration.provider_id,
      });
    }
    const replaced = this.#registrations.has(providerId);
    this.#registrations.set(providerId, registration);
    // Drop cached derived state: the adapter (and any auth/quota/discovery
    // closure) was built from the registration being replaced.
    this.#loaded.delete(providerId);
    this.#authentication.delete(providerId);
    this.#quotaCollectors.delete(providerId);
    this.#modelDiscovery.delete(providerId);
    this.#revision += 1;
    return replaced;
  }


  /** Loads every registered provider adapter. */
  async load(): Promise<ProviderRegistrySnapshot> {
    const next = new Map<ProviderId, ProviderAdapter>();
    for (const registration of this.#registrations.values()) {
      const adapter = await registration.load();
      assertAdapterIdentity(registration.provider_id, adapter);
      next.set(registration.provider_id, adapter);
    }
    this.#loaded = next;
    this.#revision += 1;
    return this.snapshot();
  }

  /** Loads one registered provider, or `undefined` when it is not registered. */
  async loadOne(providerId: string): Promise<ProviderAdapter | undefined> {
    const normalized = parseProviderId(providerId);
    const registration = this.#registrations.get(normalized);
    if (registration === undefined) return undefined;
    return this.#loadRegistration(normalized, registration);
  }

  /**
   * Resolves one adapter on demand, returning the cached instance when it has
   * already loaded. Unlike `load()`, this never evaluates a provider's module
   * graph until that provider is actually dispatched to, so heavy bespoke
   * adapters (protobuf-based providers) stay out of the startup path.
   */
  async resolve(providerId: string): Promise<ProviderAdapter | undefined> {
    const normalized = parseProviderId(providerId);
    const cached = this.#loaded.get(normalized);
    if (cached !== undefined) return cached;
    const registration = this.#registrations.get(normalized);
    if (registration === undefined) return undefined;
    return this.#loadRegistration(normalized, registration);
  }

  /** Lazily resolves and caches one provider's authentication capabilities. */
  async resolveAuthentication(providerId: string): Promise<ProviderAuthentication | undefined> {
    const normalized = parseProviderId(providerId);
    const cached = this.#authentication.get(normalized);
    if (cached !== undefined) return cached;
    const loader = this.#registrations.get(normalized)?.loadAuthentication;
    if (loader === undefined) return undefined;
    const inFlight = this.#authenticationLoading.get(normalized);
    if (inFlight !== undefined) return inFlight;
    const task = loader()
      .then((authentication) => {
        this.#authentication.set(normalized, authentication);
        return authentication;
      })
      .finally(() => this.#authenticationLoading.delete(normalized));
    this.#authenticationLoading.set(normalized, task);
    return task;
  }

  /** Lazily resolves one provider's token refresher, if it declares one. */
  async resolveRefresher(providerId: string): Promise<OAuthTokenRefresher | undefined> {
    return (await this.resolveAuthentication(providerId))?.refresher;
  }

  /** Lazily resolves one provider's OAuth login client, if it declares one. */
  async resolveLoginClient(providerId: string): Promise<OAuthLoginClient | undefined> {
    return (await this.resolveAuthentication(providerId))?.client;
  }

  /**
   * Whether a provider declares a quota collector. Sync declaration check —
   * no module is loaded — for list projections like the quota dropdown that
   * must hide providers with no quota endpoint.
   */
  hasQuotaCollector(providerId: string): boolean {
    return this.#registrations.get(parseProviderId(providerId))?.loadQuotaCollector !== undefined;
  }

  /** Lazily resolves and caches one provider's quota collector. */
  async resolveQuotaCollector(providerId: string): Promise<QuotaFetcher | undefined> {
    const normalized = parseProviderId(providerId);
    const cached = this.#quotaCollectors.get(normalized);
    if (cached !== undefined) return cached;
    const loader = this.#registrations.get(normalized)?.loadQuotaCollector;
    if (loader === undefined) return undefined;
    const inFlight = this.#quotaLoading.get(normalized);
    if (inFlight !== undefined) return inFlight;
    const task = loader()
      .then((collector) => {
        this.#quotaCollectors.set(normalized, collector);
        return collector;
      })
      .finally(() => this.#quotaLoading.delete(normalized));
    this.#quotaLoading.set(normalized, task);
    return task;
  }

  /** Lazily resolves and caches one provider's model-discovery capability. */
  async resolveModelDiscovery(providerId: string): Promise<ProviderModelDiscovery | undefined> {
    const normalized = resolveProviderId(providerId);
    const cached = this.#modelDiscovery.get(normalized);
    if (cached !== undefined) return cached;
    const loader = this.#registrations.get(normalized)?.loadModelDiscovery;
    if (loader === undefined) return undefined;
    const inFlight = this.#modelDiscoveryLoading.get(normalized);
    if (inFlight !== undefined) return inFlight;
    const task = loader()
      .then((discovery) => {
        this.#modelDiscovery.set(normalized, discovery);
        return discovery;
      })
      .finally(() => this.#modelDiscoveryLoading.delete(normalized));
    this.#modelDiscoveryLoading.set(normalized, task);
    return task;
  }

  /**
   * Single-flight adapter load shared by `loadOne`/`resolve`: concurrent
   * callers for one provider await the same load, identity drift is rejected,
   * the result is cached, and load time is recorded.
   */
  async #loadRegistration(
    providerId: ProviderId,
    registration: ProviderRegistration,
  ): Promise<ProviderAdapter> {
    const inFlight = this.#loading.get(providerId);
    if (inFlight !== undefined) return inFlight;
    const startedAt = performance.now();
    const task = (async () => {
      const adapter = await registration.load();
      assertAdapterIdentity(providerId, adapter);
      const durationMs = performance.now() - startedAt;
      metrics.proxy_provider_adapter_load_ms.observe(durationMs);
      trackAdapterLoad(providerId, durationMs);
      this.#loaded.set(providerId, adapter);
      this.#revision += 1;
      return adapter;
    })().finally(() => {
      this.#loading.delete(providerId);
    });
    this.#loading.set(providerId, task);
    return task;
  }

  /** Returns the immutable registry snapshot; disabled optional providers are absent. */
  snapshot(): ProviderRegistrySnapshot {
    return {
      revision: this.#revision,
      adapters: new Map(this.#loaded),
    };
  }

  /** Returns registration metadata without loading optional code. */
  registrations(): readonly ProviderRegistration[] {
    return [...this.#registrations.values()];
  }

  /**
   * The provider's declared upstream host, or `undefined` when it has none.
   *
   * Answers from the registry's own map, so the dispatch path's per-candidate
   * lookup does not allocate, and a provider registered after boot resolves
   * immediately (the live-read the caller depends on).
   */
  upstreamHostFor(providerId: string): { readonly hostname: string; readonly port: number } | undefined {
    let normalized: ProviderId;
    try {
      normalized = parseProviderId(providerId);
    } catch {
      return undefined;
    }
    return this.#registrations.get(normalized)?.upstream_host;
  }

  /** Whether model discovery needs a stored account credential. */
  modelDiscoveryRequiresCredential(providerId: string): boolean {
    const normalized = parseProviderId(providerId);
    return this.#registrations.get(normalized)?.modelDiscoveryRequiresCredential !== false;
  }
}

// Credential resolver

/** One control-plane credential alternative, ordered by operator preference. */
export interface CredentialAlternative {
  readonly provider_id: ProviderId;
  readonly account_id?: string | undefined;
  readonly credential_kind: CredentialKind;
  /** Secret supplied by the control plane, never read from a client request. */
  readonly secret?: string | Uint8Array | undefined;
  /** Explicit envelope label for provider-issued token normalization. */
  readonly token_envelope?: TokenEnvelope | undefined;
  /** Health/expiry/quota result from the account control plane. */
  readonly usable?: boolean | undefined;
}

/** Result of ordered credential selection, with no client-auth fields. */
export interface CredentialResolution {
  readonly credential: ResolvedCredential;
  readonly alternative_index: number;
}

/**
 * Selects the first usable upstream credential alternative in operator order.
 * Public Cartethyia authentication is intentionally absent from this interface.
 */
export class CredentialResolver {
  /**
   * Resolves an ordered list, including a genuine no-credential route.
   * @throws GatewayError when all alternatives are unavailable.
   */
  resolve(
    providerId: ProviderId,
    alternatives: readonly CredentialAlternative[],
  ): CredentialResolution {
    for (const [alternativeIndex, alternative] of alternatives.entries()) {
      if (alternative.provider_id !== providerId) continue;
      if (alternative.usable === false) continue;
      if (alternative.credential_kind === "none") {
        return {
          credential: {
            provider_id: providerId,
            ...(alternative.account_id === undefined ? {} : { account_id: alternative.account_id }),
            credential_kind: "none",
          },
          alternative_index: alternativeIndex,
        };
      }
      const secret = resolveSecret(alternative.secret, alternative.token_envelope);
      if (secret === undefined) continue;
      return {
        credential: {
          provider_id: providerId,
          ...(alternative.account_id === undefined ? {} : { account_id: alternative.account_id }),
          credential_kind: alternative.credential_kind,
          secret,
        },
        alternative_index: alternativeIndex,
      };
    }

    throw new GatewayError(
      "invalid_request",
      401,
      "No usable upstream credential is configured for the selected provider",
      { provider_id: providerId },
    );
  }
}

function resolveSecret(
  value: CredentialAlternative["secret"],
  envelope: TokenEnvelope | undefined,
): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const unwrapped = unwrapProviderToken(value, envelope);
  return unwrapped.length === 0 ? undefined : unwrapped;
}

