/**
 * BYOK (bring-your-own-key) custom-provider wire profile.
 *
 * A custom provider row persists only a base URL, an optional compatibility
 * profile, and a default wire family. Everything else the generic
 * OpenAI-compatible adapter needs — which wire families it may serve, which
 * endpoint path each of those uses, and which header carries the operator's
 * credential — is *derived* here, so the catalog registration
 * (`provider-catalog-service`) and the probe fallback (`probing-service`)
 * cannot drift apart.
 *
 * Two wire families authenticate differently, and that is protocol truth, not
 * a per-provider special case: the Anthropic Messages wire reads `x-api-key`,
 * while the OpenAI chat/responses wires read `Authorization: Bearer`.
 */
import type { WireFamily } from "../../transport/canonical-model";
import type { CompatibilityProfile } from "../provider-metadata";
import { BARE_ROOT_ENDPOINTS, type AuthHeaderShape } from "../../protocol/primitives";

/** The two wires an OpenAI-compatible root conventionally serves. */
const OPENAI_WIRE_FAMILIES: readonly WireFamily[] = ["chat", "responses"];

export interface ByokWireProfile {
  /** Header shape the upstream expects for the operator's credential. */
  readonly authHeaderShape: AuthHeaderShape;
  /** Wire families this provider may dispatch; anything else is rejected. */
  readonly supportedWireFamilies: readonly WireFamily[];
  /** Endpoint path per served wire family (bare-root paths). */
  readonly endpointPathsByWireFamily: Partial<Record<WireFamily, string>>;
}

/**
 * Which header carries the credential, derived from the served wires. A
 * provider that serves only Messages is an Anthropic-compatible upstream and
 * gets `x-api-key`; every provider that also serves an OpenAI wire keeps
 * bearer auth, because that is what those wires read.
 */
export function byokAuthHeaderShape(families: readonly WireFamily[]): AuthHeaderShape {
  const servesOpenAiWire = families.some(
    (family) => family === "chat" || family === "responses",
  );
  return !servesOpenAiWire && families.includes("messages") ? "x_api_key" : "authorization_bearer";
}

/**
 * Derives the adapter contract for one BYOK provider.
 *
 * Operator truth wins: an explicit `endpoint_paths_by_wire_family` names
 * exactly the families the provider serves. Without one, the provider serves
 * the family it was created with, and a `chat` default additionally serves
 * `responses` — the same OpenAI wire pair this gateway has always registered
 * for a bare OpenAI-compatible root. A `messages` default is deliberately
 * narrow: nothing about an Anthropic-compatible root implies the OpenAI wires.
 */
export function resolveByokWireProfile(
  wireFamilyDefault: WireFamily | null | undefined,
  compatibilityProfile: CompatibilityProfile | null | undefined,
): ByokWireProfile {
  const declaredPaths = compatibilityProfile?.endpoint_paths_by_wire_family;
  const declaredFamilies = declaredPaths
    ? (Object.keys(declaredPaths) as WireFamily[])
    : [];
  const defaultFamily: WireFamily = wireFamilyDefault ?? "chat";
  const supportedWireFamilies: readonly WireFamily[] =
    declaredFamilies.length > 0
      ? declaredFamilies
      : defaultFamily === "chat"
        ? OPENAI_WIRE_FAMILIES
        : [defaultFamily];
  const endpointPathsByWireFamily: Partial<Record<WireFamily, string>> = {};
  for (const family of supportedWireFamilies) {
    const path = declaredPaths?.[family] ?? BARE_ROOT_ENDPOINTS[family];
    if (path !== undefined) endpointPathsByWireFamily[family] = path;
  }
  return {
    authHeaderShape: byokAuthHeaderShape(supportedWireFamilies),
    supportedWireFamilies,
    endpointPathsByWireFamily,
  };
}

/**
 * Strips a base path the operator already baked into their base URL
 * (`https://api.openai.com/v1` + `/v1/chat/completions` must not join into
 * `/v1/v1/chat/completions`). A no-op when the base has no path or the
 * endpoint does not repeat it.
 */
export function stripEndpointBasePath(endpointPath: string, baseUrl: string | undefined): string {
  if (!baseUrl) return endpointPath;
  let basePath: string;
  try {
    basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    return endpointPath;
  }
  if (basePath !== "" && basePath !== "/" && endpointPath.startsWith(`${basePath}/`)) {
    return endpointPath.slice(basePath.length);
  }
  return endpointPath;
}

/**
 * Base URL an operator's model list lives under (`<base>/models`). A bare host
 * has no version segment, so it gets the `/v1` prefix; a base that already
 * carries a path (conventionally `/v1`) is used as-is.
 */
export function modelDiscoveryBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  let basePath: string;
  try {
    basePath = new URL(trimmed).pathname.replace(/\/+$/, "");
  } catch {
    return `${trimmed}/v1`;
  }
  return basePath === "" || basePath === "/" ? `${trimmed}/v1` : trimmed;
}

/**
 * URL of an operator's model list (`GET <base>/models`). See
 * `modelDiscoveryBaseUrl` for how the base segment is chosen.
 */
export function modelListUrl(baseUrl: string): string {
  return `${modelDiscoveryBaseUrl(baseUrl)}/models`;
}
