import {
  AbortCoordinator,
  ProviderAdapterError,
  capabilitiesOf,
  createModelCatalog,
  executeFetch,
  isRecord,
  lineLimit,
  mapSseStream,
  modelOf,
  readUpstreamError,
  toProviderCallError,
} from "./shared";
import type { SseEvent } from "./shared";
import { createGeminiMapper } from "../transport/protocols/gemini";
import { buildGeminiPayload, mapGeminiUsage, translateGeminiResponse } from "../domain/protocols/gemini-generate-content";
import type {
  ContextStats,
  NormalizedProviderRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderMetadata,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  ProviderSurface,
  ProviderUsage,
  RouteTarget,
  StreamEvent,
  TokenCountInput,
} from "../domain/contracts";
import type { ProviderCallError } from "../domain/contracts";

/**
 * Google Antigravity — the Cloud Code Assist agentic backend (Gemini 3,
 * Claude, GPT-OSS) authenticated with a Google OAuth access token plus a
 * provisioned Cloud Code Assist project id.
 *
 * The transport is Antigravity's internal `v1internal:streamGenerateContent`
 * SSE endpoint on `daily-cloudcode-pa.googleapis.com`, with a sandbox
 * fallback on 429/5xx. The request envelope is the Gemini agent shape: a
 * `project` + `requestId` (`agent/<id>/<ts>/<trajectory>/<step>`) + `labels`
 * wrapper around a standard Gemini generateContent payload, and responses are
 * Gemini `candidates`/`usageMetadata` frames — so the adapter reuses the
 * Gemini payload builder and stream mapper.
 *
 * Request-time credential: the current {@link ProviderRequest.credential}
 * channel is a bare string with no metadata fields, so the account's OAuth
 * token is stored as JSON (`{"accessToken": "...", "projectId": "..."}`, see
 * {@link parseAntigravityCredential} / `encodeAntigravityCredential` in the
 * Antigravity OAuth driver). The AntigravityOAuthDriver returns the project
 * id as the account id so the console can store it with the credential.
 */

export const ANTIGRAVITY_SURFACES: readonly ProviderSurface[] = ["openai-chat"];
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ACTION = "v1internal:streamGenerateContent?alt=sse";
export const ANTIGRAVITY_SYSTEM_INSTRUCTION = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";
export const ANTIGRAVITY_USER_AGENT = `antigravity/hub/2.1.4 ${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch}`;

const ANTIGRAVITY_MODELS: readonly ProviderModel[] = [
  modelOf("gemini-3.1-pro", "Gemini 3.1 Pro", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-pro-agent", "Gemini Pro Agent", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3.5-flash", "Gemini 3.5 Flash", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("gemini-3-flash", "Gemini 3 Flash", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("claude-sonnet-4-6", "Claude Sonnet 4.6", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("claude-opus-4-6", "Claude Opus 4.6", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-oss-120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true })),
];

const ANTIGRAVITY_FALLBACK_CAPABILITIES: ProviderCapabilities = capabilitiesOf({ surfaces: ANTIGRAVITY_SURFACES, reasoning: true, images: true });

interface AntigravityWireProfile {
  modelEnum?: string;
  maxOutputTokens: number;
}

export interface AntigravitySessionState {
  agentId?: string;
  trajectoryId?: string;
  sessionId?: string;
  stepIndex?: number;
  lastExecutionId?: string;
}

/** Per-wire-id request constants captured from the real Antigravity client. */
export const ANTIGRAVITY_WIRE_PROFILES: Readonly<Record<string, AntigravityWireProfile>> = {
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65_536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65_536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65_536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65_535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65_535 },
  // Claude on `daily-cloudcode-pa` rejects maxOutputTokens > 64000 with 400.
  "claude-sonnet-4-6": { maxOutputTokens: 64_000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64_000 },
};

/** Collapses logical Antigravity model ids to the upstream wire ids. */
export function antigravityWireModelId(modelId: string): string {
  if (modelId === "gemini-3.1-pro" || modelId === "gemini-3.1-pro-low") return "gemini-3.1-pro-low";
  if (modelId === "gemini-3.1-pro-high") return "gemini-pro-agent";
  if (modelId === "gemini-3.5-flash") return "gemini-3.5-flash-extra-low";
  if (modelId === "gemini-3.5-flash-medium") return "gemini-3.5-flash-low";
  if (modelId === "gemini-3.5-flash-high") return "gemini-3-flash-agent";
  return modelId;
}

/** Thinking budget per wire model, matching the Antigravity client's effort tiers. */
export function antigravityThinkingBudget(modelId: string): number | undefined {
  if (!modelId.includes("claude") && !modelId.includes("gemini-3")) return undefined;
  if (modelId.endsWith("-low")) return 1_000;
  if (modelId.endsWith("-medium")) return 4_000;
  if (modelId.endsWith("-high")) return 10_000;
  return modelId.includes("3.1-pro") ? 10_001 : 10_000;
}

function wantsWebSearch(request: NormalizedProviderRequest): boolean {
  return request.tools.some((tool) => tool.name === "web_search" || tool.name === "web_search_preview");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { content: value };
  } catch {
    return value.length > 0 ? { content: value } : {};
  }
}

/** Decoded request-time credential: Google OAuth access token + Cloud Code project id. */
export interface AntigravityCredential {
  readonly accessToken: string;
  readonly projectId: string;
}

/**
 * Parses the Antigravity request-time credential. Accepts the composite JSON
 * form (`{"accessToken", "projectId"}`) produced by the OAuth driver's
 * `encodeAntigravityCredential`; anything else (a bare JWT, empty string)
 * returns null so the adapter can raise a typed authentication error.
 */
export function parseAntigravityCredential(credential: string): AntigravityCredential | null {
  if (credential.length === 0 || credential.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(credential);
      if (isRecord(parsed)) {
        const accessToken = typeof parsed.accessToken === "string" && parsed.accessToken.length > 0 ? parsed.accessToken : undefined;
        const projectId = typeof parsed.projectId === "string" && parsed.projectId.length > 0 ? parsed.projectId : undefined;
        if (accessToken !== undefined && projectId !== undefined) return { accessToken, projectId };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Builds the Antigravity Cloud Code envelope around a standard Gemini
 * generateContent payload: `project` + agent `requestId` + wire model +
 * telemetry `labels`, plus the per-wire generation overrides (fixed
 * maxOutputTokens, thinking budget, optional googleSearch tool).
 */
function signedAntigravitySessionId(seed?: string): string {
  if (seed && /^\\d+$/.test(seed)) return seed;
  const hex = (seed ?? crypto.randomUUID()).replace(/[^0-9a-f]/gi, "").slice(0, 15) || "1";
  return String(BigInt(`0x${hex}`));
}

export function buildAntigravityRequest(request: NormalizedProviderRequest, credential: AntigravityCredential, modelId: string, conversationId?: string, sessionState?: AntigravitySessionState): Record<string, unknown> {
  const geminiPayload = buildGeminiPayload(request);
  const state = sessionState;
  if (state) {
    state.agentId ??= crypto.randomUUID();
    state.trajectoryId ??= crypto.randomUUID();
    state.sessionId ??= signedAntigravitySessionId(conversationId);
    state.stepIndex = (state.stepIndex ?? 1) + 1;
  }
  const trajectoryId = state?.trajectoryId ?? crypto.randomUUID();
  const agentId = state?.agentId ?? crypto.randomUUID();
  const step = state?.stepIndex ?? 2;
  const wireModelId = antigravityWireModelId(modelId);
  const wireProfile = ANTIGRAVITY_WIRE_PROFILES[wireModelId];
  const labels: Record<string, string> = {
    ...(state?.lastExecutionId ? { last_execution_id: state.lastExecutionId } : {}),
    trajectory_id: trajectoryId,
    last_step_index: String(step - 1),
    used_claude: String(modelId.includes("claude")),
    used_claude_conservative: String(modelId.includes("claude")),
  };
  if (wireProfile?.modelEnum !== undefined) labels.model_enum = wireProfile.modelEnum;

  const generationConfig: Record<string, unknown> = isRecord(geminiPayload.generationConfig) ? { ...geminiPayload.generationConfig } : {};
  if (wireProfile !== undefined) generationConfig.maxOutputTokens = wireProfile.maxOutputTokens;
  const budget = antigravityThinkingBudget(wireModelId);
  if (budget !== undefined) generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };

  const existingContents = Array.isArray(geminiPayload.contents) ? geminiPayload.contents as Record<string, unknown>[] : [];
  const hasIdentity = existingContents.some((content) => Array.isArray(content.parts) && (content.parts as unknown[]).some((part) => isRecord(part) && part.text === ANTIGRAVITY_SYSTEM_INSTRUCTION));
  const injectIdentity = modelId.toLowerCase().includes("claude") || modelId.toLowerCase().includes("gemini-3");
  const contents = !injectIdentity || hasIdentity ? existingContents : [{ role: "user", parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }] }, ...existingContents];
  const requestPayload: Record<string, unknown> = { ...geminiPayload, contents, labels, sessionId: state?.sessionId ?? signedAntigravitySessionId(conversationId) };
  if (Object.keys(generationConfig).length > 0) requestPayload.generationConfig = generationConfig;
  if (wantsWebSearch(request)) {
    const tools = Array.isArray(requestPayload.tools) ? [...(requestPayload.tools as Record<string, unknown>[])] : [];
    tools.push({ googleSearch: {} });
    requestPayload.tools = tools;
  }
  if (modelId.includes("claude") && !isRecord(requestPayload.toolConfig)) {
    requestPayload.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  return {
    project: credential.projectId,
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    model: wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    request: requestPayload,
  };
}

/**
 * Cloud Code Assist nests `usageMetadata` inside the `response` object of
 * each SSE frame (the plain Gemini API emits it at the top level). Hoist it
 * before the shared Gemini mapper runs so usage accounting works on both
 * wire shapes; malformed frames pass through untouched.
 */
export function normalizeAntigravityFrame(sse: SseEvent): SseEvent {
  if (sse.data.length === 0) return sse;
  try {
    const parsed: unknown = JSON.parse(sse.data);
    if (isRecord(parsed) && isRecord(parsed.response) && !isRecord(parsed.usageMetadata) && isRecord(parsed.response.usageMetadata)) {
      return { event: sse.event, data: JSON.stringify({ ...parsed, usageMetadata: parsed.response.usageMetadata }) };
    }
  } catch {
    return sse;
  }
  return sse;
}

/**
 * Folds a Gemini-style SSE event stream into a single non-stream response
 * body (the Antigravity transport only exposes the streaming endpoint).
 */
export async function foldAntigravityStream(events: AsyncIterable<StreamEvent>, model: string): Promise<{ readonly body: Record<string, unknown>; readonly usage: ProviderUsage | null }> {
  const parts: Record<string, unknown>[] = [];
  const pendingCalls = new Map<string, { name: string; args: string[] }>();
  let finishReason: string | null = null;
  let responseId: string | null = null;
  let usage: ProviderUsage | null = null;
  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        responseId = responseId ?? event.id;
        break;
      case "thinking_delta":
        parts.push({ text: event.text, thought: true });
        break;
      case "text_delta":
        parts.push({ text: event.text });
        break;
      case "tool_call_start":
        pendingCalls.set(event.callId, { name: event.name, args: [] });
        break;
      case "tool_call_delta": {
        const call = pendingCalls.get(event.callId);
        if (call !== undefined) call.args.push(event.delta);
        break;
      }
      case "tool_call_end": {
        const call = pendingCalls.get(event.callId);
        if (call !== undefined) parts.push({ functionCall: { id: event.callId, name: call.name, args: parseJsonObject(call.args.join("")) } });
        break;
      }
      case "usage":
        usage = event.usage;
        break;
      case "message_stop":
        finishReason = event.reason;
        break;
    }
  }
  const usageMetadata: Record<string, unknown> = {};
  if (usage !== null) {
    if (usage.inputTokens !== null) usageMetadata.promptTokenCount = usage.inputTokens;
    if (usage.outputTokens !== null) usageMetadata.candidatesTokenCount = usage.outputTokens;
    if (usage.totalTokens !== null) usageMetadata.totalTokenCount = usage.totalTokens;
    if (usage.cacheReadTokens !== null) usageMetadata.cachedContentTokenCount = usage.cacheReadTokens;
  }
  const body: Record<string, unknown> = {
    candidates: [{ content: { role: "model", parts }, finishReason: finishReason === "length" ? "MAX_TOKENS" : "STOP" }],
    usageMetadata,
  };
  if (responseId !== null) body.responseId = responseId;
  return { body, usage: usage ?? mapGeminiUsage(body) };
}

/** Maximum in-memory conversation sessions before the oldest is evicted.
 * Matches the per-IP flight tracker's bounded-map pattern: V8 Map preserves
 * insertion order, so eviction drops the oldest-inserted entry in O(1). */
const MAX_SESSION_STATES = 256;

/** Google Antigravity (Cloud Code Assist) adapter. */
export class GoogleAntigravityAdapter implements ProviderAdapter {
  private readonly sessionStates = new Map<string, AntigravitySessionState>();
  readonly metadata: ProviderMetadata = {
    id: "antigravity",
    displayName: "Antigravity",
    protocol: "gemini",
    credentialKind: "oauth",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(ANTIGRAVITY_MODELS);
  readonly capabilities: ProviderCapabilities = { ...ANTIGRAVITY_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    if (this.models.get(modelId) === null) {
      throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`, statusCode: 404, routeScope: "provider" });
    }
    return { providerId: this.metadata.id, modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "openai-chat") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only serves the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    }
    const credential = parseAntigravityCredential(input.credential);
    if (credential === null) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "Antigravity requires an OAuth credential with its Cloud Code project id.", statusCode: 401, routeScope: "account" });
    }
    const conversationId = input.headers?.get("x-conversation-id") ?? `${credential.projectId}:${input.target.modelId}`;
    let state = this.sessionStates.get(conversationId);
    if (!state) {
      state = {};
      if (this.sessionStates.size >= MAX_SESSION_STATES) {
        // Evict the oldest-inserted conversation — V8 Map preserves insertion
        // order, so the first key is the least-recently-created session.
        const oldest = this.sessionStates.keys().next();
        if (!oldest.done) this.sessionStates.delete(oldest.value as string);
      }
      this.sessionStates.set(conversationId, state);
    }
    const payload = buildAntigravityRequest(input.request, credential, input.target.modelId, conversationId, state);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${credential.accessToken}`,
      "user-agent": ANTIGRAVITY_USER_AGENT,
    };
    const attempt = (endpoint: string) => this.roundTrip(input, endpoint, payload, headers, state);
    try {
      return await attempt(ANTIGRAVITY_DAILY_ENDPOINT);
    } catch (error) {
      // Sandbox fallback mirrors the Antigravity client: transient upstream
      // failures (rate limit or 5xx) retry once against the sandbox endpoint.
      if (error instanceof ProviderAdapterError && (error.statusCode === 429 || (error.statusCode ?? 0) >= 500)) {
        return attempt(ANTIGRAVITY_SANDBOX_ENDPOINT);
      }
      throw error;
    }
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }

  private async roundTrip(input: ProviderRequest, endpoint: string, payload: Record<string, unknown>, headers: Record<string, string>, state: AntigravitySessionState): Promise<ProviderOutput> {
    const { request, signal, network } = input;
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${endpoint}/${ANTIGRAVITY_ACTION}`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network);
      if (!response.ok) throw await readUpstreamError(response);
      if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Antigravity returned an empty stream body", routeScope: "provider" });
      // The Antigravity transport only exposes the streaming endpoint; a
      // non-stream request drains the SSE frames and folds them into one body.
      const mapper = createGeminiMapper();
      const events = mapSseStream(
        { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
        (sse) => mapper(normalizeAntigravityFrame(sse)),
      );
      if (!request.stream) {
        const folded = await foldAntigravityStream(events, request.model);
        if (typeof folded.body.responseId === "string") state.lastExecutionId = folded.body.responseId;
        return { mode: "non_stream", body: translateGeminiResponse(folded.body, request.sourceSurface, request.model), usage: folded.usage ?? undefined };
      }
      streamHandedOff = true;
      const statefulEvents = (async function* (): AsyncIterable<StreamEvent> {
        for await (const event of events) {
          if (event.type === "message_start" && event.id) state.lastExecutionId = event.id;
          yield event;
        }
      })();
      return { mode: "stream", events: statefulEvents };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }
}

/**
 * Convenience instance for non-registry wiring (console probes, tests).
 * The default registry constructs its own instance.
 */
export const googleAntigravityAdapter = new GoogleAntigravityAdapter();