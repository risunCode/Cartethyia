/**
 * GitHub Copilot model directory.
 *
 * The account's own `/models` response is authoritative: it reports exactly
 * which SKUs the subscription may use, and two facts the static catalog cannot
 * know — the real context window per SKU, and which request surface each SKU
 * answers on. Copilot serves some SKUs only on `/responses`, so a catalog that
 * pins every row to chat silently loses them.
 *
 * The envelope is OpenAI-shaped (`{ data: [...] }`) but the entries are not.
 * `supported_endpoints` names the surfaces a row answers on, limits live under
 * `capabilities.limits.max_context_window_tokens`, and capability under
 * `capabilities.supports`. The shared tolerant fetcher reads a top-level
 * `context_length` and a `modality` string, so against this listing it would
 * publish every row at the `200_000/64_192` floors and pin every row to chat —
 * so this module reads the Copilot shape directly.
 *
 * Every row is returned with an explicit wire family and endpoint path, so a
 * responses-only SKU is registered against `/responses` instead of being
 * mislabelled as chat.
 */
import type { ModelDefinition } from "../../provider-registry";
import { isRecord } from "../../../protocol/primitives";
import {
  boundedUpstreamArray,
  boundedUpstreamNumber,
  sanitizeUpstreamLabel,
} from "../../provider-metadata";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
import type { DiscoveryInput } from "../../discovery/discovery-types";
import { GITHUB_PROVIDER_ID, GITHUB_ENDPOINT_PATH, GITHUB_RESPONSES_ENDPOINT_PATH, recordGithubLongContextModels } from "./github";
import { GITHUB_REQUEST_HEADERS, parseGithubCredential } from "./github-oauth";

/** A context window above this is unsatisfiable headroom, not a real limit. */
const MAX_CONTEXT = 1_000_000_000;
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_OUTPUT_LIMIT = 64_192;

function positiveLimit(value: unknown): number | undefined {
  return boundedUpstreamNumber(value, { min: 1, max: MAX_CONTEXT });
}

/**
 * The surfaces a row answers on, normalized to the canonical paths this
 * gateway registers.
 *
 * A row that supports neither chat nor responses is skipped rather than
 * defaulted: Copilot also serves a native Anthropic `/v1/messages` surface for
 * some SKUs, and this adapter speaks only the OpenAI wire. Registering such a
 * row as chat would publish a route that fails on first dispatch.
 */
function wireFamilyFor(entry: Record<string, unknown>): "chat" | "responses" | undefined {
  const declared = boundedUpstreamArray(entry.supported_endpoints);
  if (!declared) return "chat";
  const endpoints = new Set<string>();
  for (const value of declared) {
    const label = sanitizeUpstreamLabel(value);
    if (label !== undefined) endpoints.add(label.replace(/^\/v1(?=\/)/, ""));
  }
  // Chat is preferred when a row supports both: it is the surface every
  // OpenAI-compatible client already speaks, and the upstream answers it for
  // the same SKU. Responses is used only when chat is absent.
  if (endpoints.has("/chat/completions")) return "chat";
  if (endpoints.has("/responses")) return "responses";
  return undefined;
}

/** Whether the row advertises a capability flag under `capabilities.supports`. */
function supports(entry: Record<string, unknown>, key: string): boolean {
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
  const declared = isRecord(capabilities?.supports) ? capabilities.supports : undefined;
  return declared?.[key] === true;
}

function toModelDefinition(entry: Record<string, unknown>): ModelDefinition | undefined {
  const modelId = sanitizeUpstreamLabel(entry.id);
  if (modelId === undefined) return undefined;
  const wireFamily = wireFamilyFor(entry);
  if (wireFamily === undefined) return undefined;
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
  const limits = isRecord(capabilities?.limits) ? capabilities.limits : undefined;
  const contextLimit = positiveLimit(limits?.max_context_window_tokens) ?? DEFAULT_CONTEXT_LIMIT;
  const declaredOutput =
    positiveLimit(limits?.max_output_tokens) ?? DEFAULT_OUTPUT_LIMIT;
  // A maximum output above the context window is unsatisfiable, so it is
  // clamped the same way every other catalog row is.
  const outputLimit = Math.min(declaredOutput, contextLimit);
  const vision = supports(entry, "vision");
  return {
    modelId,
    wireFamily,
    endpointPath: wireFamily === "responses" ? GITHUB_RESPONSES_ENDPOINT_PATH : GITHUB_ENDPOINT_PATH,
    contextLimit,
    outputLimit,
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    reasoning: true,
    toolCall: true,
    webSearch: false,
    cost: modelsDevCatalog.costFor(GITHUB_PROVIDER_ID, modelId),
  };
}

/**
 * Reads the account's model directory.
 *
 * The credential arrives as the stored secret, which for this provider is the
 * `{access, apiHost}` envelope — not a bare token, and not the host the
 * request must go to. Both are decoded here: sending the JSON verbatim would
 * put the envelope on the wire as the bearer, and using the provider default
 * host would query the wrong account's catalog.
 *
 * Returns `null` — not an empty list — on any upstream failure, so the caller
 * can tell "the directory could not be read" apart from "the directory is
 * empty" and keep the static catalog in place instead of clearing the
 * provider's models.
 */
export async function discoverGithubModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const { access, apiHost } = parseGithubCredential(input.credential);
  const fetcher = input.fetcher ?? fetch;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal =
    input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
  try {
    const response = await fetcher(`https://${apiHost}/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${access}`, ...GITHUB_REQUEST_HEADERS },
      signal,
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return null;
    const entries = boundedUpstreamArray(payload.data);
    if (!entries) return null;
    const byId = new Map<string, ModelDefinition>();
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const definition = toModelDefinition(entry);
      if (definition !== undefined) byId.set(definition.modelId, definition);
    }
    if (byId.size === 0) return null;
    const models = [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
    // The dispatch-time request builder cannot see a catalog row, so the
    // qualifying ids are handed to the adapter here, where the account's real
    // window is known.
    recordGithubLongContextModels(models);
    return models;
  } catch {
    return null;
  }
}
