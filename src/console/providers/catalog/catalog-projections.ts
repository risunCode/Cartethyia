/**
 * Catalog row projections and endpoint-path resolution shared by the console
 * catalog stores.
 *
 * `endpointPathForProviderModel` encodes the endpoint precedence the Add-Model
 * path and the public catalog must agree on: operator compatibility profile >
 * the provider's own static catalog > the generic per-wire default, with the
 * provider's base path stripped so a versioned root cannot double a `/v1`
 * segment. `mapProviderRow` is the single `providers` row projection.
 */
import { isBundledProviderId, providerBaseUrl } from "../../../providers/provider-registry";
import type { CompatibilityProfile } from "../../../providers/provider-metadata";
import { supportedWireFamiliesForProvider } from "../../../providers/discovery/probe-wire";
import { providers } from "../../../persistence/schema";
import type { WireFamily } from "../../../transport/canonical-model";
import type { ProviderRecord } from "./contracts";

export const DEFAULT_ENDPOINT_BY_WIRE_FAMILY: Record<WireFamily, string> = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  native: "/v1/chat/completions",
};
export function endpointPathForProviderModel(
  providerId: string,
  wireFamily: WireFamily,
  compatibilityProfile: unknown,
  storedBaseUrl: string | null,
  staticEndpoints?: Partial<Record<WireFamily, string>>,
): string {
  const profile =
    compatibilityProfile !== null &&
    typeof compatibilityProfile === "object" &&
    !Array.isArray(compatibilityProfile)
      ? (compatibilityProfile as CompatibilityProfile)
      : undefined;
  // Operator profile > the provider's own static catalog (cline serves chat
  // from `/chat/completions` on its versioned base; the generic `/v1/…`
  // default would join into an unreachable `/api/v1/v1/…`) > default+strip.
  const endpointPath =
    profile?.endpoint_paths_by_wire_family?.[wireFamily] ??
    staticEndpoints?.[wireFamily] ??
    DEFAULT_ENDPOINT_BY_WIRE_FAMILY[wireFamily];
  const baseUrl =
    storedBaseUrl ??
    (isBundledProviderId(providerId) ? providerBaseUrl(providerId) : undefined);
  if (!baseUrl) return endpointPath;
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  if (basePath && basePath !== "/" && endpointPath.startsWith(`${basePath}/`)) {
    return endpointPath.slice(basePath.length);
  }
  return endpointPath;
}

/** Projects a `providers` row into the console's provider record shape. */
export function mapProviderRow(row: typeof providers.$inferSelect): ProviderRecord {
  const supportedWireFamilies = supportedWireFamiliesForProvider(
    row.id,
    row.wireFamilyDefault,
    row.compatibilityProfile,
  );
  return {
    providerId: row.id,
    tenantId: row.tenantId,
    enabled: row.enabled,
    isBuiltIn: isBundledProviderId(row.id),
    configured: false,
    requiresAccount: row.requiresAccount,
    supportsModelDiscovery: !isBundledProviderId(row.id),
    ...(row.wireFamilyDefault ? { wireFamilyDefault: row.wireFamilyDefault } : {}),
    ...(supportedWireFamilies ? { supportedWireFamilies } : {}),
    ...(row.capabilityProfile
      ? { capabilityProfile: row.capabilityProfile as Record<string, unknown> }
      : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.compatibilityProfile
      ? { compatibilityProfile: row.compatibilityProfile as CompatibilityProfile }
      : {}),
  };
}
