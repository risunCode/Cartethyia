/**
 * Kilo Code model directory.
 *
 * The directory at `/api/gateway/models` is an OpenRouter-shaped catalog: each
 * entry carries limits under `top_provider` (`context_length`,
 * `max_completion_tokens`), modality under `architecture.input_modalities`, and
 * capability under `supported_parameters`. The shared tolerant fetcher reads
 * none of those — it expects the OpenAI `/models` shape with a top-level
 * `context_length` and a `modality` string — so using it here would publish
 * every row at the 200k/64k defaults and drop vision and tools from models that
 * have them. That is a wrong capability, not a missing one: `toolCall: false`
 * makes the preflight strip `tools` from the request.
 *
 * So this module reads the OpenRouter shape directly and derives each row from
 * the provider's own declaration.
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
import { KILO_ENDPOINT_PATH, KILO_PROVIDER_ID } from "./kilo";
import { parseKiloCredential } from "./kilo-oauth";

/** Kilo Code's published model directory. */
export const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models" as const;

const MAX_CONTEXT = 1_000_000_000;
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_OUTPUT_LIMIT = 64_192;

/** A context window above this is unsatisfiable headroom, not a real limit. */
function positiveLimit(value: unknown): number | undefined {
  return boundedUpstreamNumber(value, { min: 1, max: MAX_CONTEXT });
}

function inputModalities(entry: Record<string, unknown>): readonly string[] {
  const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
  const declared = boundedUpstreamArray(architecture?.input_modalities);
  if (!declared) return ["text"];
  const known = new Set<string>(["text"]);
  for (const value of declared) {
    const modality = sanitizeUpstreamLabel(value);
    // `pdf` is Kilo Code's spelling of the same capability the canonical
    // `document` part carries; the rest pass through by their canonical name.
    if (modality === "image") known.add("image");
    else if (modality === "file" || modality === "pdf") known.add("document");
    else if (modality === "audio") known.add("audio");
  }
  return [...known];
}

function supportedParameters(entry: Record<string, unknown>): ReadonlySet<string> {
  const declared = boundedUpstreamArray(entry.supported_parameters);
  if (!declared) return new Set();
  const names = new Set<string>();
  for (const value of declared) {
    const name = sanitizeUpstreamLabel(value);
    if (name !== undefined) names.add(name.toLowerCase());
  }
  return names;
}

/** Builds one catalog row from a directory entry, or `undefined` when unusable. */
function toModelDefinition(entry: Record<string, unknown>): ModelDefinition | undefined {
  const modelId = sanitizeUpstreamLabel(entry.id);
  if (modelId === undefined) return undefined;
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
  const contextLimit =
    positiveLimit(topProvider?.context_length) ??
    positiveLimit(entry.context_length) ??
    DEFAULT_CONTEXT_LIMIT;
  const declaredOutput =
    positiveLimit(topProvider?.max_completion_tokens) ?? DEFAULT_OUTPUT_LIMIT;
  // A maximum output above the context window is unsatisfiable, so it is
  // clamped the same way every other catalog row is.
  const outputLimit = Math.min(declaredOutput, contextLimit);
  const parameters = supportedParameters(entry);
  return {
    modelId,
    // Kilo Code exposes one OpenAI-compatible chat surface; its directory
    // lists no Responses or Messages route, so every row is chat.
    wireFamily: "chat",
    endpointPath: KILO_ENDPOINT_PATH,
    contextLimit,
    outputLimit,
    modalities: { input: inputModalities(entry), output: ["text"] },
    reasoning: parameters.has("reasoning") || parameters.has("include_reasoning"),
    toolCall: parameters.has("tools"),
    cost: modelsDevCatalog.costFor(KILO_PROVIDER_ID, modelId),
  };
}

/**
 * Reads Kilo Code's model directory.
 *
 * The credential arrives as the stored secret, which for this provider is the
 * `{accessToken, orgId}` envelope — not a bare token. Sending it verbatim would
 * put the JSON on the wire as the bearer, so it is decoded here first. The
 * directory currently answers identically without any credential, but the
 * envelope is still decoded rather than skipped: an unparseable credential
 * means the account row is corrupt, and reporting that beats silently
 * succeeding on an endpoint that may start honoring auth.
 *
 * Returns `null` — not an empty list — on any upstream failure, so the caller
 * can tell "the directory could not be read" apart from "the directory is
 * empty" and keep the static catalog in place instead of clearing the
 * provider's models.
 */
export async function discoverKiloModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const { accessToken } = parseKiloCredential(input.credential);
  const fetcher = input.fetcher ?? fetch;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal =
    input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
  try {
    const response = await fetcher(KILO_MODELS_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
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
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}
