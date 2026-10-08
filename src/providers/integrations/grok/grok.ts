/**
 * Grok Build adapter.
 *
 * This is the subscription CLI product at cli-chat-proxy.grok.com, not the
 * paid xAI API at api.x.ai. The adapter accepts only xAI device-OAuth
 * credentials, force-streams the Responses request, and keeps the CLI-specific
 * session, reasoning, tool, and stored-item compatibility boundary in one
 * place. Transport timeout/abort and SSE decoding are delegated to the shared
 * OpenAI-compatible adapter.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { GatewayError } from "../../../transport/gateway-error";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import {
  OpenAICompatibleAdapter,
  withBearerAuthentication,
} from "../../compatible-adapter";
import type { ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext } from "../../provider-registry";
import { providerBaseUrl, boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-metadata";
import { isRecord } from "../../../protocol/primitives";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
import type { ReasoningEffortLevel } from "../../../transport/translation/thinking";
import type { FetchLike } from "../../quota/quota-contracts";
import { resolveInboundSessionId, resolvePromptCacheKey } from "../../operations/session-resolution";
import {
  buildGrokUserAgent,
  getGrokVersion,
} from "../../operations/client-versions";
import { resolveGrokTurnIndex } from "./grok-turn-index";
import { getGrokInstallId } from "./grok-install-id";

export const GROK_PROVIDER_ID = "grok" as const;
export const GROK_BASE_URL = providerBaseUrl("grok");
export const GROK_CLIENT_IDENTIFIER = "grok-shell" as const;
export const GROK_TOKEN_AUTH = "xai-grok-cli" as const;

const GROK_HOSTED_TOOLS = new Set([
  "web_search",
  "x_search",
  "web_search_preview",
  "file_search",
  "image_generation",
  "code_interpreter",
  "mcp",
  "local_shell",
]);
const GROK_ALLOWED_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "include",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "metadata",
  "prompt_cache_key",
]);
const GROK_SERVER_ID = /^(rs|fc|resp|msg)_/i;
const GROK_NATIVE_ID = /^(rs|msg|fc)_[0-9a-f-]{20,}$/i;
const GROK_EFFORTS = new Set<ReasoningEffortLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const GROK_MODELS_URL = `${GROK_BASE_URL}/v1/models`;

interface GrokModelDiscoveryOptions {
  readonly credential: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: FetchLike;
}

import type { ModelDefinition } from "../../provider-registry";

const grokModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
  reasoningEfforts?: readonly ReasoningEffortLevel[],
): ModelDefinition => ({
  modelId,
  wireFamily: "responses",
  endpointPath: "/v1/responses",
  contextLimit,
  outputLimit,
  modalities: { input: ["text", "image"], output: ["text"] },
  reasoning,
  ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  toolCall: true,
  cost: modelsDevCatalog.costFor(GROK_PROVIDER_ID, modelId),
});

/** Static fallback catalog used before (or when) the per-account live catalog is available. */
export const GROK_MODELS: readonly ModelDefinition[] = [
  // Upstream /v1/models advertises a 500k context and 1M max-completion
  // budget separately; keep the output ceiling independent from context.
  grokModel("grok-4.7", 500_000, 1_000_000, true, ["low", "medium", "high", "xhigh"]),
  grokModel("grok-4.5", 500_000, 64_000, true, ["low", "medium", "high", "xhigh"]),
  grokModel("grok-4.6", 500_000, 64_000, true, ["low", "medium", "high", "xhigh"]),
];

interface GrokModelCatalogEntry extends Record<string, unknown> {
  readonly id?: unknown;
  readonly model?: unknown;
  readonly modelId?: unknown;
  readonly name?: unknown;
  readonly hidden?: unknown;
  readonly _meta?: unknown;
  readonly context_window?: unknown;
  readonly contextWindow?: unknown;
  readonly max_completion_tokens?: unknown;
  readonly maxCompletionTokens?: unknown;
  readonly reasoning_effort?: unknown;
  readonly reasoningEffort?: unknown;
  readonly supports_reasoning_effort?: unknown;
  readonly supportsReasoningEffort?: unknown;
  readonly reasoning_efforts?: unknown;
  readonly reasoningEfforts?: unknown;
  readonly supports_backend_search?: unknown;
  readonly supportsBackendSearch?: unknown;
}

function modelEntries(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return null;
  for (const key of ["data", "models", "results"] as const) {
    const entries = boundedUpstreamArray(payload[key]);
    if (entries !== undefined) return entries.filter(isRecord);
  }
  return null;
}

function parseGrokReasoningMenu(value: unknown): {
  readonly efforts: readonly ReasoningEffortLevel[];
  readonly defaultEffort?: ReasoningEffortLevel;
} {
  if (!Array.isArray(value)) return { efforts: [] };
  const efforts: ReasoningEffortLevel[] = [];
  let defaultEffort: ReasoningEffortLevel | undefined;
  for (const entry of value) {
    const option = typeof entry === "string" ? { value: entry } : isRecord(entry) ? entry : undefined;
    const effort = typeof option?.value === "string" ? option.value.trim() : "";
    if (!GROK_EFFORTS.has(effort as ReasoningEffortLevel) || efforts.includes(effort as ReasoningEffortLevel)) continue;
    efforts.push(effort as ReasoningEffortLevel);
    if (option?.default === true && defaultEffort === undefined) defaultEffort = effort as ReasoningEffortLevel;
  }
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

/**
 * Discovers the Grok Build Responses catalog with Grok-specific completion,
 * reasoning and backend-search metadata preserved.
 */
export async function fetchGrokModels(
  options: GrokModelDiscoveryOptions,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  try {
    const response = await fetcher(GROK_MODELS_URL, {
      headers: {
        authorization: `Bearer ${options.credential}`,
        "x-xai-token-auth": GROK_TOKEN_AUTH,
        "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
        "x-grok-client-mode": "headless",
        "x-grok-client-version": getGrokVersion(),
        "user-agent": buildGrokUserAgent(),
        accept: "application/json",
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return null;
    const entries = modelEntries(await response.json());
    if (entries === null) return null;
    const models = new Map<string, ModelDefinition>();
    const profiles = new Map<string, ModelDefinition>();
    const defaultEfforts = new Map<string, ReasoningEffortLevel>();
    for (const raw of entries) {
      const entry = raw as GrokModelCatalogEntry;
      const metadata = isRecord(entry._meta) ? entry._meta : undefined;
      if (entry.hidden === true || metadata?.hidden === true) continue;
      const id = sanitizeUpstreamLabel(
        entry.id ?? entry.model ?? entry.modelId ?? metadata?.model ?? metadata?.modelId,
      );
      if (!id) continue;
      const reference = GROK_MODELS.find((model) => model.modelId.toLowerCase() === id.toLowerCase());
      const contextLimit =
        boundedUpstreamNumber(entry.context_window ?? entry.contextWindow, { min: 1, max: 10_000_000 }) ??
        reference?.contextLimit ?? 500_000;
      const outputLimit =
        boundedUpstreamNumber(entry.max_completion_tokens ?? entry.maxCompletionTokens, {
          min: 1,
          max: 10_000_000,
        }) ?? reference?.outputLimit ?? 64_000;
      const menu = parseGrokReasoningMenu(entry.reasoning_efforts ?? entry.reasoningEfforts);
      const metadataEffort = normalizeEffort(entry.reasoning_effort ?? entry.reasoningEffort);
      const supportsReasoning =
        entry.supports_reasoning_effort ?? entry.supportsReasoningEffort;
      const reasoning =
        supportsReasoning === true ||
        (supportsReasoning === undefined && menu.efforts.length > 0) ||
        (supportsReasoning === undefined && menu.efforts.length === 0 && reference?.reasoning === true);
      const model: ModelDefinition = {
        modelId: id,
        wireFamily: "responses",
        endpointPath: "/v1/responses",
        contextLimit,
        outputLimit,
        modalities: reference?.modalities ?? { input: ["text"], output: ["text"] },
        reasoning,
        ...(menu.efforts.length === 0 ? {} : { reasoningEfforts: menu.efforts }),
        toolCall: true,
        cost: modelsDevCatalog.costFor(GROK_PROVIDER_ID, id),
      };
      models.set(id, model);
      profiles.set(id.toLowerCase(), model);
      if (metadataEffort !== undefined) defaultEfforts.set(id.toLowerCase(), metadataEffort);
    }
    if (models.size === 0) return null;
    discoveredModels.clear();
    for (const [id, model] of profiles) discoveredModels.set(id, model);
    // Replace discovered defaults, retaining the static defaults as fallback
    // only for catalog ids absent from this upstream response.
    for (const id of defaultGrokEfforts.keys()) {
      if (profiles.has(id)) defaultGrokEfforts.delete(id);
    }
    for (const [id, effort] of defaultEfforts) defaultGrokEfforts.set(id, effort);
    return [...models.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}

/**
 * Whether the wire accepts a `reasoning.effort` for this model.
 *
 * Derived from the catalog rather than restated as a model-name regex. Three
 * separate hand-maintained lists of "which grok models are current" had already
 * drifted apart once (`grok-4.7` was in the catalog and the request builder but
 * missing from the discovery allowlist), so the catalog is the single source:
 * a model is effort-capable exactly when it is a served model that the catalog
 * declares as reasoning-capable. Suffixed variants of a served model (e.g.
 * `grok-4.6-high`) inherit that capability, matching the previous prefix rule.
 */
const discoveredModels = new Map<string, ModelDefinition>();
const defaultGrokEfforts = new Map<string, ReasoningEffortLevel>([
  ["grok-4.7", "high"],
  ["grok-4.5", "high"],
  ["grok-4.6", "high"],
]);

function grokModelDefinition(modelId: string): ModelDefinition | undefined {
  const normalized = modelId.toLowerCase();
  return (
    discoveredModels.get(normalized) ??
    GROK_MODELS.find((model) => model.modelId.toLowerCase() === normalized)
  );
}

function grokDefaultEffort(modelId: string): ReasoningEffortLevel | undefined {
  const exact = modelId.toLowerCase();
  const discovered = defaultGrokEfforts.get(exact);
  if (discovered !== undefined) return discovered;
  for (const [id, effort] of defaultGrokEfforts) {
    if (exact === id || exact.startsWith(`${id}-`)) return effort;
  }
  return undefined;
}

function supportsReasoningEffort(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  const exact = grokModelDefinition(normalized);
  if (exact?.reasoningEfforts !== undefined) return exact.reasoningEfforts.length > 0;
  return GROK_MODELS.some(
    (model) =>
      model.reasoning &&
      (normalized === model.modelId.toLowerCase() ||
        normalized.startsWith(`${model.modelId.toLowerCase()}-`)),
  );
}

async function grokHeaders(
  context: ProviderDispatchContext,
  request?: CanonicalRequest,
  candidate?: ProviderDispatchTarget,
): Promise<Record<string, string>> {
  const stableSession =
    (typeof request?.conversation?.conversation_id === "string" && request.conversation.conversation_id.trim()
      ? request.conversation.conversation_id.trim()
      : undefined) ?? resolveInboundSessionId(context, request);
  const version = getGrokVersion();
  const agentId = await getGrokInstallId();
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "accept-encoding": "identity",
    "x-xai-token-auth": GROK_TOKEN_AUTH,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    "x-grok-client-version": version,
    "x-grok-client-mode": "headless",
    "x-authenticateresponse": "authenticate-response",
    "user-agent": buildGrokUserAgent(version),
    "x-grok-agent-id": agentId,
    "x-grok-req-id": randomUUID(),
  };
  // The auth store retains the display label, not xAI's upstream user ID, so
  // do not substitute a local account or tenant id in identity headers.
  if (candidate?.model_id) {
    headers["x-grok-model-override"] = candidate.model_id;
  }
  const session = stableSession;
  if (session) {
    headers["x-grok-session-id"] = session;
    headers["x-grok-conv-id"] = session;
    const turn = context.request_headers?.["x-grok-turn-idx"]?.trim();
    if (turn && /^\d+$/.test(turn)) {
      // A real `grok` CLI client tracks its own prompt index; never override it.
      headers["x-grok-turn-idx"] = turn;
    } else {
      headers["x-grok-turn-idx"] = String(
        resolveGrokTurnIndex(session, request, context.request_identity),
      );
    }
  }
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  headers.traceparent = `00-${traceId}-${spanId}-01`;
  return headers;
}

function normalizeEffort(value: unknown): ReasoningEffortLevel | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim().toLowerCase();
  const normalized = effort === "minimal" ? "low" : effort === "max" ? "xhigh" : effort;
  return GROK_EFFORTS.has(normalized as ReasoningEffortLevel)
    ? (normalized as ReasoningEffortLevel)
    : undefined;
}

function normalizeInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  // Provider-specific id hygiene only. Tool call/output pairing is owned by
  // the shared canonical repair (`repairRequestToolCalls` in the
  // request/preparer, which runs for every route including grok) plus the
  // factory Responses payload path — wire-side pairing filters duplicated
  // that logic and are deleted.
  return input.filter((item) => {
    if (typeof item === "string") return !GROK_SERVER_ID.test(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const value = item as Record<string, unknown>;
    if (value.type === "item_reference") return false;
    if (typeof value.id === "string" && GROK_SERVER_ID.test(value.id) && !GROK_NATIVE_ID.test(value.id))
      delete value.id;
    return true;
  });
}

function normalizeTools(payload: Record<string, unknown>): void {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return;
  const validNames = new Set<string>();
  const hostedTypes = new Set<string>();
  const normalized: Record<string, unknown>[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const tool = raw as Record<string, unknown>;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (GROK_HOSTED_TOOLS.has(type)) {
      hostedTypes.add(type);
      normalized.push(tool);
      continue;
    }
    // Tools arrive factory-normalized (flat `{type:"function",name,parameters}`;
    // canonical tools are flat, so the legacy nested `function.*` resolution
    // duplicated the factory payload path and is deleted). Only grok wire
    // strictness stays here: trimmed names, empty-name drop, parameters
    // fallback, custom-tool synthesis.
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name.trim()) continue;
    const parameters =
      type === "custom"
        ? {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          }
        : tool.parameters !== null && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
          ? tool.parameters
          : { type: "object", properties: {} };
    const flat: Record<string, unknown> = {
      type: "function",
      name: name.trim().slice(0, 128),
      parameters,
    };
    const description = tool.description;
    if (typeof description === "string" && description.length > 0) flat.description = description;
    validNames.add(flat.name as string);
    normalized.push(flat);
  }
  if (normalized.length === 0) {
    delete payload.tools;
    delete payload.tool_choice;
    return;
  }
  payload.tools = normalized;
  const choice = payload.tool_choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const value = choice as Record<string, unknown>;
    const type = typeof value.type === "string" ? value.type : "";
    if (type === "function" || type === "custom") {
      // Unlike `tools`, `tool_choice` genuinely arrives nested: the chat
      // encoder writes `{type:"function", function:{name}}` and
      // `{type:"custom", custom:{name}}`, so these reads are not a legacy
      // leftover even though the tools loop above dropped its own nested path.
      const fn = value.function;
      const nested = fn && typeof fn === "object" && !Array.isArray(fn) ? fn as Record<string, unknown> : undefined;
      const custom = value.custom;
      const nestedCustom = custom && typeof custom === "object" && !Array.isArray(custom) ? custom as Record<string, unknown> : undefined;
      const name = typeof value.name === "string"
        ? value.name
        : typeof nested?.name === "string"
          ? nested.name
          : typeof nestedCustom?.name === "string"
            ? nestedCustom.name
            : "";
      if (validNames.has(name)) payload.tool_choice = { type: "function", name };
      else delete payload.tool_choice;
    } else if (!hostedTypes.has(type)) {
      delete payload.tool_choice;
    }
  }
}

function normalizeGrokPayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
): void {
  payload.stream = true;
  if (payload.store === undefined || payload.store === null) payload.store = false;
  payload.input = normalizeInput(payload.input);
  normalizeTools(payload);

  const requestedModel = typeof payload.model === "string" && payload.model.length > 0
    ? payload.model
    : candidate.model_id;
  payload.model = requestedModel;
  const requestedEffort = normalizeEffort(
    (payload.reasoning as Record<string, unknown> | undefined)?.effort ??
      payload.reasoning_effort,
  );
  const reasoning =
    payload.reasoning && typeof payload.reasoning === "object" && !Array.isArray(payload.reasoning)
      ? { ...(payload.reasoning as Record<string, unknown>) }
      : {};
  reasoning.summary ??= "concise";
  const modelDefinition = grokModelDefinition(requestedModel);
  const supportsEffort = supportsReasoningEffort(requestedModel);
  const normalizedEffort = requestedEffort ?? grokDefaultEffort(requestedModel);
  if (
    supportsEffort &&
    normalizedEffort &&
    (modelDefinition?.reasoningEfforts === undefined ||
      modelDefinition.reasoningEfforts.includes(normalizedEffort as ReasoningEffortLevel))
  ) {
    reasoning.effort = normalizedEffort;
  } else {
    delete reasoning.effort;
  }
  delete payload.reasoning_effort;
  payload.reasoning = reasoning;

  const modelOutputLimit = modelDefinition?.outputLimit;
  if (modelOutputLimit !== null && modelOutputLimit !== undefined) {
    const requestedOutput = boundedUpstreamNumber(payload.max_output_tokens, {
      min: 1,
      max: 10_000_000,
    });
    payload.max_output_tokens =
      requestedOutput === undefined
        ? modelOutputLimit
        : Math.min(requestedOutput, modelOutputLimit);
  }

  const include = Array.isArray(payload.include) ? [...payload.include] : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  payload.include = include;

  const cacheKey = resolvePromptCacheKey(request);
  if (cacheKey !== undefined && typeof payload.prompt_cache_key !== "string")
    payload.prompt_cache_key = cacheKey.slice(0, 512);

  for (const key of Object.keys(payload)) {
    if (!GROK_ALLOWED_FIELDS.has(key)) delete payload[key];
  }
}


const GrokConfig = withBearerAuthentication({
  provider_id: GROK_PROVIDER_ID,
  base_url: GROK_BASE_URL,
  endpoint_paths_by_wire_family: { responses: "/v1/responses" },
  extra_headers: { accept: "text/event-stream", "accept-encoding": "identity" },
  buildExtraHeaders: grokHeaders,
  prePayload: normalizeGrokPayload,
});

const GrokInnerAdapter = new OpenAICompatibleAdapter(GrokConfig);

/** Dedicated Grok Build provider adapter. */
export const GrokAdapter: ProviderAdapter = {
  provider_id: GROK_PROVIDER_ID,
  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<import("../../../transport/canonical-model").CanonicalEvent> {
    if (context.credential.credential_kind !== "oauth") {
      throw new GatewayError(
        "invalid_request",
        400,
        "grok requires an xAI OAuth device credential",
      );
    }
    yield* GrokInnerAdapter.dispatch(request, candidate, context);
  },
};

/** Factory for tests and custom egress. */
export function createGrokAdapter(
  options: { readonly fetch?: typeof fetch } = {},
): ProviderAdapter {
  if (!options.fetch) return GrokAdapter;
  const config = withBearerAuthentication({ ...GrokConfig, fetchImpl: options.fetch });
  const adapter = new OpenAICompatibleAdapter(config);
  return {
    provider_id: GROK_PROVIDER_ID,
    async *dispatch(request, candidate, context) {
      if (context.credential.credential_kind !== "oauth") {
        throw new GatewayError(
          "invalid_request",
          400,
          "grok requires an xAI OAuth device credential",
        );
      }
      yield* adapter.dispatch(request, candidate, context);
    },
  };
}
