// Provider assembly: builtin registry construction, BYOK wiring, and DB catalog materialization.
import type { WireFamily } from "../../transport/canonical-model";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { GatewayError } from "../../transport/gateway-error";
import {
  isBundledProviderId,
  parseProviderId,
  type ProviderId,
  type ModelDefinition,
  ProviderRegistry,
} from "../provider-registry";
import { OpenAICompatibleAdapter } from "../compatible-adapter";
import { resolveByokWireProfile } from "./byok-wire-profile";
import { BUNDLED_PROVIDER_MODULES } from "../default-registry";
import { getCachedModels } from "./model-catalog-cache";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { providers } from "../../persistence/schema";
import type { CompatibilityProfile } from "../provider-metadata";
import { resolveCustomCliHeaders } from "./custom-cli-headers";
import { GATEWAY_USER_AGENT } from "./gateway-user-agent";
import { isIP } from "node:net";
import { isAddressAllowed } from "../../network/ssrf";
import type { SsrfPolicy } from "../../config";
/**
 * Idempotently materializes every shipped provider in the database catalog.
 * The canonical provider definition supplies identity and routing defaults;
 * this only creates rows that tenant/account routing needs.
 */
export async function seedBundledProviders(db: CartethyiaDatabase): Promise<void> {
  const rows = BUNDLED_PROVIDER_MODULES.map((provider) => ({
    id: provider.id,
    wireFamilyDefault: provider.wireFamilyDefault,
    compatibilityProfile: provider.compatibility ?? null,
    enabled: true,
    requiresAccount: provider.requiresAccount,
  }));
  // One upsert for the whole bundled catalog. The previous shape ran a bulk
  // INSERT and then one UPDATE per provider (40 sequential statements on the
  // boot path) purely to reconcile routing defaults and merge compatibility
  // profiles. `excluded` carries the row we just tried to insert, so the same
  // reconciliation happens in a single statement: routing defaults are
  // overwritten from the bundle, while the compatibility profile is *merged*
  // so console edits to other keys survive a boot.
  await db
    .insert(providers)
    .values(rows)
    .onConflictDoUpdate({
      target: providers.id,
      set: {
        wireFamilyDefault: sql`excluded.wire_family_default`,
        requiresAccount: sql`excluded.requires_account`,
        compatibilityProfile: sql`COALESCE(${providers.compatibilityProfile}, '{}'::jsonb) || COALESCE(excluded.compatibility_profile, '{}'::jsonb)`,
      },
    });
}

export interface ByokUpstreamHost {
  readonly hostname: string;
  readonly port: number;
}


/**
 * Live view of every registered provider's `upstream_host`.
 *
 * Read at dispatch time instead of snapshotted: a custom provider registered
 * (or re-registered) after boot must resolve its SSRF binding on the very
 * next request, and a snapshot taken during startup would keep reporting
 * `undefined` for it until the process restarted.
 */
export function liveProviderUpstreamHosts(registry: ProviderRegistry): {
  readonly get: (providerId: string) => ByokUpstreamHost | undefined;
} {
  // A live lookup, not a snapshot: a custom provider registered after boot must
  // resolve its SSRF binding on the very next request. Returning a closure
  // instead of a Map-shaped object keeps the dispatch path from allocating an
  // array per candidate lookup — only `.get` was ever used.
  return { get: (providerId) => registry.upstreamHostFor(providerId) };
}

export interface BundledProviderCatalog {
  readonly modelsByProvider: ReadonlyMap<string, readonly ModelDefinition[]>;
}

export async function bundledModelCatalog(
  registry: ProviderRegistry,
): Promise<BundledProviderCatalog> {
  const modelsByProvider = new Map<string, readonly ModelDefinition[]>();
  for (const registration of registry.registrations()) {
    const definitions = registration.loadModels
      ? await getCachedModels(registration.provider_id, registration.loadModels)
      : [];
    modelsByProvider.set(registration.provider_id, definitions);
    const endpoints = {
      ...(registration.endpoint_paths_by_wire_family ?? {}),
    } as Partial<Record<WireFamily, string>>;
    for (const definition of definitions) {
      const existing = endpoints[definition.wireFamily];
      if (existing !== undefined && existing !== definition.endpointPath) {
        throw new Error(
          `Conflicting endpoint paths for ${registration.provider_id}/${definition.wireFamily}`,
        );
      }
      endpoints[definition.wireFamily] = definition.endpointPath;
    }
  }
  return { modelsByProvider };
}

/**
 * Last successfully applied BYOK config per normalized provider ID.
 * Makes repeated `syncByokProviders` runs cheap: an unchanged row is skipped,
 * while a changed one is re-registered instead of being rejected.
 */
const byokRegistrationFingerprints = new Map<string, string>();

function byokFingerprint(
  baseUrl: string,
  profile: CompatibilityProfile | null,
  wireFamilyDefault: WireFamily | null,
): string {
  return JSON.stringify({ baseUrl, profile, wireFamilyDefault });
}

/**
 * Registers every DB-persisted BYOK provider (`providers.base_url IS NOT NULL`,
 * `enabled = true`) into `registry` as an OpenAI-compatible adapter, and
 * returns each one's upstream host/port so the proxy handler can run the
 * same SSRF-validated network binding built-ins already get.
 *
 * Idempotent by construction: re-running after an operator edits a row
 * replaces that provider's registration instead of failing, so a custom
 * provider becomes dispatchable without a process restart.
 */
export async function registerByokProviders(
  registry: ProviderRegistry,
  db: CartethyiaDatabase,
  ssrfPolicy: SsrfPolicy = {},
): Promise<ReadonlyMap<string, ByokUpstreamHost>> {
  const rows = await db
    .select()
    .from(providers)
    .where(and(isNotNull(providers.baseUrl), eq(providers.enabled, true)));
  const hosts = new Map<string, ByokUpstreamHost>();
  for (const row of rows) {
    if (!row.baseUrl) continue;
    const baseUrl = row.baseUrl;
    let providerId: ProviderId;
    try {
      providerId = parseProviderId(row.id);
    } catch {
      throw new GatewayError("invalid_request", 400, `invalid BYOK provider ID: ${row.id}`);
    }
    if (isBundledProviderId(providerId)) {
      throw new GatewayError("invalid_request", 409, `BYOK provider ID collides with a built-in: ${row.id}`, {
        provider_id: providerId,
      });
    }
    const compatibilityProfile = row.compatibilityProfile as CompatibilityProfile | null;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
      if (
        (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
        !parsedUrl.hostname
      ) {
        throw new Error("unsupported BYOK URL");
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("invalid_request", 400, `invalid BYOK base URL for provider ${row.id}`);
    }
    // IP literals are rejected at registration; DNS names are revalidated at dispatch.
    if (isIP(parsedUrl.hostname) !== 0 && !isAddressAllowed(parsedUrl.hostname, ssrfPolicy)) {
      throw new GatewayError(
        "invalid_request",
        400,
        `BYOK provider ${row.id} host is blocked (private/unsafe address)`,
      );
    }
    const defaultPort = parsedUrl.protocol === "http:" ? 80 : 443;
    hosts.set(providerId, {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
    });
    const fingerprint = byokFingerprint(baseUrl, compatibilityProfile, row.wireFamilyDefault);
    if (byokRegistrationFingerprints.get(providerId) === fingerprint) continue;
    const wireProfile = resolveByokWireProfile(row.wireFamilyDefault, compatibilityProfile);
    registry.upsert({
      provider_id: providerId,
      upstream_host: {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
      },
      load: async () =>
        new OpenAICompatibleAdapter({
          provider_id: providerId,
          base_url: baseUrl,
          authentication_header_shape: wireProfile.authHeaderShape,
          buildExtraHeaders: (_context, _request, candidate) => {
            // Explicit gateway identity wins over CLI cloaking, and Codex /
            // Claude-Code-shaped traffic can never take this path: this hook
            // only runs for BYOK custom rows, never bundled first-party
            // adapters. Unset restores the CLI headers below.
            if (compatibilityProfile?.gateway_user_agent === true) {
              return {
                "user-agent": GATEWAY_USER_AGENT,
                ...(compatibilityProfile?.extra_headers ?? {}),
              };
            }
            const sendCli = compatibilityProfile?.cli_identity !== false;
            const cliHeaders = sendCli
              ? resolveCustomCliHeaders(candidate?.wire_family ?? "chat")
              : {};
            return {
              ...cliHeaders,
              ...(compatibilityProfile?.extra_headers ?? {}),
            };
          },
          ...(compatibilityProfile?.extra_query_params
            ? { extra_query_params: compatibilityProfile.extra_query_params }
            : {}),
          // Operator paths when declared, otherwise the derived bare-root paths
          // for exactly the wire families this provider serves.
          endpoint_paths_by_wire_family: wireProfile.endpointPathsByWireFamily,
          ...(compatibilityProfile?.streaming_usage_mode
            ? { streaming_usage_mode: compatibilityProfile.streaming_usage_mode }
            : {}),
          ...(compatibilityProfile?.structured_output
            ? { structured_output: compatibilityProfile.structured_output }
            : {}),
        }),
    });
    byokRegistrationFingerprints.set(providerId, fingerprint);
  }
  return hosts;
}

/**
 * Re-applies one provider's BYOK registration after a console mutation so a
 * newly created or edited custom provider is dispatchable immediately.
 *
 * A row that no longer qualifies (`base_url` cleared, or disabled) is dropped:
 * leaving a stale registration behind would keep an adapter and an SSRF host
 * alive for an upstream the operator just removed. Returns the upstream host
 * when the provider is registered, otherwise `undefined`.
 */
export async function syncByokProvider(
  registry: ProviderRegistry,
  db: CartethyiaDatabase,
  providerId: string,
  ssrfPolicy: SsrfPolicy = {},
): Promise<ByokUpstreamHost | undefined> {
  let normalized: ProviderId;
  try {
    normalized = parseProviderId(providerId);
  } catch {
    return undefined;
  }
  if (isBundledProviderId(normalized)) return undefined;
  const fingerprintBefore = byokRegistrationFingerprints.get(normalized);
  const hosts = await registerByokProviders(registry, db, ssrfPolicy);
  const host = hosts.get(normalized);
  // `registerByokProviders` only walks qualifying rows, so a provider that
  // stopped qualifying is never visited — drop it here instead.
  if (host === undefined && fingerprintBefore !== undefined) {
    registry.unregister(normalized);
    byokRegistrationFingerprints.delete(normalized);
  }
  return host;
}
