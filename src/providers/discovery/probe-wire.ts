/**
 * Wire-family and endpoint resolution for discovered provider models.
 *
 * Probing and model sync both need to answer "which wire family and which
 * endpoint path does this model id use?" before a request can be built. The
 * answer is a layered merge — operator overrides, the discovery module's own
 * definition, the provider's static catalog, then a generic default — and it
 * lives here so `probing-service.ts` owns orchestration rather than merge
 * precedence.
 *
 * This module used to carry its own `DISCOVERY_CONFIG_BY_PROVIDER` table of
 * endpoint paths. It was a byte-identical second copy of
 * `PROVIDER_CAPABILITIES[id].endpointPathsByWireFamily` in the provider
 * registry, and it had already drifted: `ollamacloud` was listed here with four
 * paths while the registry map was the only one the catalog service validated
 * against. `discoveryPathsFor` now reads the registry, so a provider declares
 * its endpoint paths once.
 */
import type { WireFamily } from "../../transport/canonical-model";
import type { CompatibilityProfile } from "../provider-metadata";
import { isBundledProviderId, type ModelDefinition } from "../provider-registry";
import { PROVIDER_CAPABILITIES } from "../default-registry";
import { stripEndpointBasePath, resolveByokWireProfile } from "../operations/byok-wire-profile";

/**
 * Endpoint paths declared for one provider by the provider registry.
 *
 * Returns `undefined` for a provider that declares none, so the caller's `??`
 * layering still falls through to the static catalog and then the generic
 * default instead of pinning a wrong path.
 */
export function discoveryPathsFor(
  providerId: string,
): Partial<Record<WireFamily, string>> | undefined {
  const capability = (PROVIDER_CAPABILITIES as Record<
    string,
    { endpointPathsByWireFamily?: Partial<Record<WireFamily, string>> } | undefined
  >)[providerId];
  return capability?.endpointPathsByWireFamily;
}

/**
 * Constrains a resolved wire family to the provider's declared contract.
 *
 * A stored `models` row, a bundled catalog row, or a discovery guess is a cache
 * of the derivation, not an authority — when it names a family the provider does
 * not serve, the adapter rejects the request with `capability_unsupported` and
 * the operator sees an opaque 400. `corrected` tells the caller to recompute the
 * endpoint for the family that replaced it, because the two must stay paired.
 */
export function constrainWireFamily(
  wireFamily: WireFamily,
  declaredFamilies: readonly WireFamily[] | undefined,
): { readonly wireFamily: WireFamily; readonly corrected: boolean } {
  if (
    declaredFamilies === undefined ||
    declaredFamilies.length === 0 ||
    declaredFamilies.includes(wireFamily)
  ) {
    return { wireFamily, corrected: false };
  }
  return { wireFamily: declaredFamilies[0] as WireFamily, corrected: true };
}

/** A resolved wire family plus the endpoint path it must be dispatched to. */
export interface DiscoveredModelWire {
  readonly wireFamily: WireFamily;
  readonly endpointPath: string;
}

/**
 * Wire families a provider may actually serve, ordered by preference, derived
 * from the same declarations dispatch and discovery use: a built-in's registry
 * paths, a custom row's BYOK profile. Returns `undefined` when the provider
 * declares nothing, which leaves the caller's own choice untouched.
 *
 * This is the provider *contract*: the adapter rejects any other family with
 * `capability_unsupported`, so a stored row, a catalog guess, or a discovery
 * payload naming a family outside this set can only produce a 400. Callers use
 * it to constrain their own resolution rather than trusting a cached wire.
 */
export function supportedWireFamiliesForProvider(
  providerId: string,
  wireFamilyDefault: WireFamily | null | undefined,
  compatibilityProfile: unknown,
): readonly WireFamily[] | undefined {
  if (isBundledProviderId(providerId)) {
    const declared = discoveryPathsFor(providerId);
    return declared === undefined ? undefined : (Object.keys(declared) as WireFamily[]);
  }
  const profile =
    compatibilityProfile !== null &&
    typeof compatibilityProfile === "object" &&
    !Array.isArray(compatibilityProfile)
      ? (compatibilityProfile as CompatibilityProfile)
      : undefined;
  return resolveByokWireProfile(wireFamilyDefault ?? null, profile).supportedWireFamilies;
}

/**
 * Final wire merge for one discovered model. Priority:
 * operator compat-profile overrides > the discovery module's own
 * definition (cline ships `/chat/completions`, the generic OpenAI fetcher
 * ships `/v1/*` + responses inference) > the provider's static catalog >
 * the generic default. The default alone produced unreachable rows (e.g.
 * `/v1/chat/completions` on cline's versioned `/api/v1` base), so it is
 * strictly the last resort.
 */
interface DiscoveredWireInput {
  readonly resolvedWireFamily: WireFamily;
  readonly resolvedEndpointPath: string;
  readonly discoveredWireFamily?: WireFamily;
  readonly discoveredEndpointPath?: string;
  readonly staticEndpoints?: Partial<Record<WireFamily, string>>;
  readonly endpointOverrides?: Partial<Record<WireFamily, string>>;
  /**
   * Wire families the provider may actually serve, when it declares them — a
   * BYOK row's derived profile. A generic `/models` fetch carries no wire
   * information and guesses from the model id, so a guess outside this set is
   * discarded: without it a Messages-only custom provider is discovered onto
   * `chat` rows the adapter rejects at dispatch.
   */
  readonly supportedWireFamilies?: readonly WireFamily[];
  /**
   * Provider base URL the endpoint is joined onto at dispatch. A discovered
   * `/v1`-prefixed path on a versioned root (`https://host/v1`) would join
   * into a doubled `/v1/v1/…`, so it is stripped to the root-relative form
   * (mirrors the Add-Model path). Operator overrides are explicit and never
   * stripped.
   */
  readonly baseUrl?: string;
}

export function applyDiscoveredWire(input: DiscoveredWireInput): DiscoveredModelWire {
  const declared = input.supportedWireFamilies ?? [];
  // The discovered family only wins when the provider's own contract admits it;
  // its endpoint travels with it, so an admitted family is what decides whether
  // the discovered path may be used at all.
  const discoveredFamily =
    input.discoveredWireFamily !== undefined &&
    (declared.length === 0 || declared.includes(input.discoveredWireFamily))
      ? input.discoveredWireFamily
      : undefined;
  const wireFamily =
    discoveredFamily ??
    (declared.length === 0 || declared.includes(input.resolvedWireFamily)
      ? input.resolvedWireFamily
      : (declared[0] ?? input.resolvedWireFamily));

  const override = input.endpointOverrides?.[wireFamily];
  if (override !== undefined) return { wireFamily, endpointPath: override };
  const endpointPath =
    (discoveredFamily !== undefined ? input.discoveredEndpointPath : undefined) ??
    input.staticEndpoints?.[wireFamily] ??
    input.resolvedEndpointPath;
  return { wireFamily, endpointPath: stripEndpointBasePath(endpointPath, input.baseUrl) };
}

/**
 * The provider's own static catalog endpoint for a wire family, if any.
 * Used by explicit-wire probes and manual registration so a bundled
 * provider on a versioned base (cline: `/chat/completions` on `/api/v1`)
 * is never probed/registered against the generic `/v1/…` default, which
 * would join into an unreachable path and surface as upstream 404.
 */
export function staticEndpointForWire(
  catalog: ReadonlyMap<string, readonly ModelDefinition[]>,
  providerId: string,
  wireFamily: WireFamily,
): string | undefined {
  return catalog.get(providerId)?.find((def) => def.wireFamily === wireFamily)?.endpointPath;
}

function matchModelWireFamily(
  modelId: string,
  rules: ReadonlyArray<{ pattern: string; wire_family: WireFamily }> | undefined,
): WireFamily | undefined {
  if (!rules?.length) return undefined;
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern).test(modelId)) return rule.wire_family as WireFamily;
    } catch {
      // Invalid pattern is rejected at write time; be tolerant at read time.
    }
  }
  return undefined;
}

/** The provider-scoped inputs that decide a model's wire family and path. */
export interface ProviderWireContext {
  wireFamilyDefault: WireFamily | undefined;
  endpointPathsByWireFamily: Partial<Record<WireFamily, string>> | undefined;
  modelWireFamilies: ReadonlyArray<{ pattern: string; wire_family: WireFamily }> | undefined;
}

/** Resolves one model's wire family and endpoint from the layered sources. */
export function resolveDiscoveredWire(
  modelId: string,
  ctx: ProviderWireContext,
  discoveryPaths: Partial<Record<WireFamily, string>> | undefined,
  fallbackEndpoints: Record<WireFamily, string>,
): DiscoveredModelWire {
  const wireFamily =
    matchModelWireFamily(modelId, ctx.modelWireFamilies) ??
    ctx.wireFamilyDefault ??
    ("chat" as WireFamily);
  const endpointPath =
    ctx.endpointPathsByWireFamily?.[wireFamily] ??
    discoveryPaths?.[wireFamily] ??
    fallbackEndpoints[wireFamily];
  return { wireFamily, endpointPath };
}
