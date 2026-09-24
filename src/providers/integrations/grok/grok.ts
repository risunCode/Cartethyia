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
import { providerBaseUrl } from "../../provider-metadata";
import { resolveInboundSessionId, resolvePromptCacheKey } from "../../operations/session-resolution";
import {
  buildGrokUserAgent,
  getGrokVersion,
  resolveGrokVersion,
} from "../../operations/client-versions";
import { resolveGrokTurnIndex } from "./grok-turn-index";

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



import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

const grokModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
): ModelDefinition =>
  defineModel({
    id: modelId,
    wireFamily: "responses",
    endpoint: "/v1/responses",
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning,
    toolCall: true,
    webSearch: true,
  });

/** Static fallback catalog used before (or when) the per-account live catalog is available. */
export const GROK_MODELS: readonly ModelDefinition[] = [
  grokModel("grok-4.7", 500_000, 64_000, true),
  grokModel("grok-4.5", 500_000, 64_000, true),
  grokModel("grok-4.6", 500_000, 64_000, true),
];

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
function supportsReasoningEffort(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
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
  // Await discovery so the true latest client version is stamped on every
  // dispatch; the pinned fallback only applies on a real network failure.
  await resolveGrokVersion();
  const version = getGrokVersion();
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "accept-encoding": "identity",
    "x-xai-token-auth": GROK_TOKEN_AUTH,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    "x-grok-client-version": version,
    "x-grok-client-mode": "headless",
    "x-authenticateresponse": "authenticate-response",
    "user-agent": buildGrokUserAgent(version),
    "x-grok-req-id": randomUUID(),
  };
  // Deliberately absent, matching what the real Grok CLI sends rather than what
  // a reference gateway adds for its own bookkeeping:
  // - `x-grok-agent-id` only exists when a CLI runs in agent mode. This gateway
  //   has no agent id, and minting one would fingerprint a mode that is not
  //   running.
  // - Account `email` and `userId` headers need identity the OAuth credential
  //   store does not keep. Dispatch only has `account_id`, and the fingerprint
  //   that actually identifies the client is already covered above.
  // Hosted tools (`web_search`, `x_search`) and freeform tool parameters are not
  // reshaped here either. The shared Responses payload forwards `tools` and
  // `tool_choice` verbatim, so a Grok-only rewrite would clobber a shape that is
  // already valid. A reference gateway needs that rewrite only because it
  // converts from Chat Completions first.
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
      headers["x-grok-turn-idx"] = String(resolveGrokTurnIndex(session, request));
    }
  }
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  headers.traceparent = `00-${traceId}-${spanId}-01`;
  return headers;
}

function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim().toLowerCase();
  if (effort === "minimal") return "low";
  if (effort === "max") return "xhigh";
  return ["low", "medium", "high", "xhigh"].includes(effort) ? effort : undefined;
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
  const supportsEffort = supportsReasoningEffort(requestedModel);
  if (supportsEffort && requestedEffort) reasoning.effort = requestedEffort;
  else delete reasoning.effort;
  delete payload.reasoning_effort;
  payload.reasoning = reasoning;

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
  supported_wire_families: ["responses"],
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
