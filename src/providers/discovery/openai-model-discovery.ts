import type { ModelDefinition } from "../provider-registry";
import { isRecord } from "../../protocol/primitives";
import {
  boundedUpstreamArray,
  boundedUpstreamNumber,
  sanitizeUpstreamLabel,
} from "../provider-metadata";
import { modelsDevCatalog } from "./models-dev-catalog";
import { isResponsesNativeModelId } from "../model-definition";
interface FetchModelsOptions {
  readonly baseUrl: string;
  /**
   * Canonical provider id for this discovery run. Passed through to the base
   * catalog so a model's context/output limits and pricing come from the row
   * for the provider actually serving it; omitting it opts into the
   * unambiguous-bare lookup, which fails closed when the catalog disagrees.
   */
  readonly providerId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

/**
 * Tolerant OpenAI-compatible `/models` fetcher — provider-specific
 * `src/providers/discovery/openai-model-discovery.ts`. Handles `data|models|items`, various
 * pricing/context shapes, and responses wire family detection.
 */
export async function fetchOpenAICompatibleModels(
  options: FetchModelsOptions,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  try {
    const response = await fetcher(url, {
      headers: {
        ...(options.headers ?? {}),
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const entries = extractEntries(payload);
    if (entries === null) return null;
    const byId = new Map<string, ModelDefinition>();
    for (const entry of entries) {
      const id = sanitizeUpstreamLabel(entry.id);
      if (id === undefined) continue;
      const fallback = modelsDevCatalog.resolve(options.providerId ?? "", id);
      const parsedContext =
        positiveNumber(entry.context_length) ??
        positiveNumber((entry as Record<string, unknown>).input_token_limit) ??
        positiveNumber(entry.contextWindow) ??
        positiveNumber(entry.max_input_tokens);
      const contextWindow = parsedContext ?? fallback?.contextLimit ?? 200_000;

      const parsedOutput =
        positiveNumber(entry.max_output_tokens) ??
        positiveNumber((entry as Record<string, unknown>).max_output_tokens) ??
        positiveNumber(entry.maxTokens);
      const maxOutputTokens = parsedOutput ?? fallback?.outputLimit ?? 64_192;
      const outputTokens = Math.min(maxOutputTokens, contextWindow);

      const cost = modelsDevCatalog.costFor(options.providerId ?? "", id);

      // Capability comes from the upstream's own `modality` field, never from
      // the base catalog: that lookup is keyed by bare model id and keeps only
      // the first provider row, so it would attribute a stranger's capabilities
      // to this gateway's serving. An undeclared capability is left to the
      // routing ladder's filter → degrade path.
      const rawModality = typeof entry.modality === "string" ? entry.modality : "";
      const hasImage = rawModality.includes("image");
      const responsesWire = isResponsesNativeModelId(id);
      byId.set(id, {
        modelId: id,
        wireFamily: responsesWire ? "responses" : "chat",
        endpointPath: responsesWire ? "/v1/responses" : "/v1/chat/completions",
        contextLimit: contextWindow,
        outputLimit: outputTokens,
        modalities: { input: hasImage ? ["text", "image"] : ["text"], output: ["text"] },
        reasoning: false,
        toolCall: true,
        webSearch: false,
        cost,
      });
    }
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  return boundedUpstreamNumber(value, { min: 1, max: 1_000_000_000 }) ?? null;
}




function extractEntries(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (typeof payload !== "object" || payload === null) return null;
  const rec = payload as Record<string, unknown>;
  for (const key of ["data", "models", "items"] as const) {
    const value = rec[key];
    const bounded = boundedUpstreamArray(value);
    if (bounded) return bounded.filter(isRecord) as Record<string, unknown>[];
  }
  return null;
}
