/**
 * Antigravity adapter.
 *
 * Antigravity is Google's Cloud Code Assist backend
 * (`daily-cloudcode-pa.googleapis.com`), reached via Google OAuth. The wire
 * reuses the Gemini `buildGeminiPayload` envelope from `protocol/request/gemini.ts`,
 * wrapped in Antigravity's agent envelope (`project`/`requestId`/wire
 * `model`/`request`) and POSTed to the fixed `v1internal:{generate,stream
 * Generate}Content` RPC — no per-model URL path.
 *
 * Antigravity-specific wire nuance lives in `./protocol.ts`:
 *   - `antigravity/hub/<version>` User-Agent with lazy update-manifest
 *     version discovery
 *   - logical → wire model-id resolution (`antigravityWireModelId`) so the
 *     console can show friendly names while upstream uses deployment ids
 *   - per-wire-id `maxOutputTokens` + `labels.model_enum` override
 *   - Gemini 3+ skip-thought-signature bypass for the first unsigned
 *     `functionCall` in each `model`-role turn
 *   - `loadCodeAssist` project-id lookup (cached per access-token hash;
 *     warmed by the OAuth exchange in `./auth.ts`)
 *
 * Cross-brand model catalog: Antigravity serves Google Gemini SKUs,
 * Anthropic Claude SKUs, and one GPT-OSS SKU behind the same wire.
 */
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason } from "../../../transport/canonical-model";
import { GatewayError } from "../../../transport/gateway-error";
import { firstUserText } from "../../../transport/canonical-model";
import { decodeSseEvents } from "../../../transport/streaming";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { usageFromProvider } from "../../usage";
import { isRecord } from "../../../protocol/primitives";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildGeminiPayload } from "../../../protocol/request/gemini";
import {
  decodeGeminiStreamEvent,
  geminiCandidate,
  mapGeminiUsage,
  responseParts,
} from "../../../protocol/response/gemini";
import {
  antigravityWireModelId,
  applySkipThoughtSignatureBypass,
  ensureAntigravityVersion,
  getAntigravityModelWireProfile,
  getAntigravityUserAgent,
  loadAntigravityProject,
} from "./antigravity-protocol";
import type {
  ProviderDispatchTarget,
  ProviderAdapter,
  ProviderDispatchContext,
} from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";
import { createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity" as const;
export const ANTIGRAVITY_BASE_URL = providerBaseUrl("antigravity");
/** Cloud Code Assist accepts `/v1internal:generateContent` for the same body Gemini's v1beta accepts. */
const GENERATE_PATH = "/v1internal:generateContent" as const;
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

const antigravityModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
): ModelDefinition =>
  defineModel({
    id: modelId,
    wireFamily: "chat",
    endpoint: GENERATE_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning,
    toolCall: true,
    webSearch: false,
  });

export const ANTIGRAVITY_MODELS: readonly ModelDefinition[] = [
  // Claude via Antigravity (Anthropic-branded SKUs, Gemini wire)
  antigravityModel("claude-sonnet-4-5", 250_000, 64_000, true),
  antigravityModel("claude-opus-4-5", 250_000, 64_000, true),
  // Gemini
  antigravityModel("gemini-2.5-flash", 1_048_576, 65_535, true),
  antigravityModel("gemini-2.5-flash-lite", 1_048_576, 65_535, true),
  antigravityModel("gemini-2.5-pro", 1_048_576, 65_536, true),
  antigravityModel("gemini-3-flash", 1_048_576, 65_536, true),
  antigravityModel("gemini-3.1-flash-image", 200_000, 64_000, false),
  antigravityModel("gemini-3.1-flash-lite", 1_048_576, 65_535, true),
  antigravityModel("gemini-3.1-pro", 1_048_576, 65_535, true),
  antigravityModel("gemini-3.5-flash", 1_048_576, 65_536, true),
  antigravityModel("gemini-3.6-flash", 1_048_576, 65_536, true),
  antigravityModel("gemini-3.7-flash", 1_048_576, 65_536, true),
  antigravityModel("gemini-3.8-flash", 1_048_576, 65_536, true),
  // GPT-OSS
  antigravityModel("gpt-oss-120b", 131_072, 32_768, true),
  // Tab preview (short-context)
  antigravityModel("tab_flash_lite_preview", 16_384, 4_096, false),
  antigravityModel("tab_jump_flash_lite_preview", 16_384, 4_096, false),
];


const STREAM_GENERATE_PATH = "/v1internal:streamGenerateContent?alt=sse" as const;

// Antigravity model catalog.

// Adapter

interface AntigravityAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  /** Maximum session states when the host needs explicit limits. */
  readonly sessionStateMaxEntries?: number;
  /** Idle session lifetime in milliseconds. */
  readonly sessionStateIdleTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

class AntigravityAdapter implements ProviderAdapter {
  readonly provider_id = ANTIGRAVITY_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly sessionStates: AntigravitySessionStore;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? ANTIGRAVITY_BASE_URL).replace(/\/+$/, "");
    this.sessionStates = new AntigravitySessionStore({
      ...(options.sessionStateMaxEntries === undefined ? {} : { maxEntries: options.sessionStateMaxEntries }),
      ...(options.sessionStateIdleTtlMs === undefined ? {} : { idleTtlMs: options.sessionStateIdleTtlMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** Number of live conversation states (diagnostics/tests). */
  sessionStateSize(): number {
    return this.sessionStates.size;
  }

  /** Resets one conversation/model state, or all model states for a conversation. */
  resetSession(routeIdentity: string, wireModelId?: string): number {
    if (wireModelId !== undefined)
      return this.sessionStates.resetByPrefix(sessionStateKey(routeIdentity, wireModelId));
    return this.sessionStates.resetByPrefix(`${sessionIdentityDigest(routeIdentity)}:`);
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (
      candidate.wire_family !== "chat" &&
      candidate.wire_family !== "responses" &&
      candidate.wire_family !== "messages"
    ) {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `antigravity supports chat/responses/messages, got ${candidate.wire_family}`,
      );
    }
    if (context.credential.credential_kind !== "oauth") {
      throw new GatewayError(
        "invalid_request",
        400,
        `antigravity: Google OAuth credential required (got credential_kind=${context.credential.credential_kind})`,
      );
    }
    const accessToken = context.credential.secret
      ? new TextDecoder().decode(context.credential.secret).trim()
      : "";
    if (!accessToken) {
      throw new GatewayError(
        "authentication_failed",
        401,
        "antigravity: OAuth access token is required",
      );
    }

    const model = candidate.model_id || request.model;
    const wireModelId = antigravityWireModelId(model);
    const url = `${this.baseUrl}${request.stream ? STREAM_GENERATE_PATH : GENERATE_PATH}`;

    // Conversation stickiness: one state per (conversation, model); other
    // models under the same conversation reset so parallel stale states
    // never shadow the live one. The anonymous fallback is scoped per
    // credential (never one static bucket shared by all anonymous traffic).
    const accountId = context.credential.account_id;
    const credentialScope =
      accountId ??
      (context.credential.secret
        ? `cred:${createHash("sha256").update(context.credential.secret).digest("hex").slice(0, 16)}`
        : "anon");
    const routeIdentity =
      request.conversation?.conversation_id ??
      request.conversation_id ??
      `account:${credentialScope}`;
    const stateKey = sessionStateKey(routeIdentity, wireModelId);
    const sessionState = this.sessionStates.getOrCreate(stateKey);
    // Reset sibling-model states under the same conversation so parallel
    // stale states never shadow the live one; the live key is kept.
    this.sessionStates.resetByPrefix(`${sessionIdentityDigest(routeIdentity)}:`, stateKey);

    // Kick a background client-version discovery (best-effort; the pinned
    // fallback ships in the user-agent immediately). Not awaited: the
    // dispatch does not block on the update-manifest fetch.
    void ensureAntigravityVersion(this.fetchFn);
    // Best-effort project-id: CloudCode accepts requests without one for
    // free-tier accounts; enterprise/subscribed accounts need it. Cached
    // per access-token hash, so this is a single background call at first
    // use per token.
    const projectId = await loadAntigravityProject(accessToken, {
      baseUrl: this.baseUrl,
      fetcher: this.fetchFn,
      signal: context.abort_signal,
    });

    const payload = buildAntigravityEnvelope(
      request,
      projectId,
      wireModelId,
      model,
      sessionState,
      firstUserText(request),
    );

    const outboundFetch: typeof fetch =
      (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    try {
      const headers = {
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": getAntigravityUserAgent(),
      };
      const attempt = (target: string): Promise<Response> =>
        outboundFetch(target, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: lifecycle.signal,
        });
      let response = await attempt(url);
      if (!response.ok && isFailoverStatus(response.status)) {
        // Production→sandbox auto-failover (captured client behavior): one
        // bounded retry on a fresh host for throttled/server-side failures.
        // Auth and client errors never fail over.
        const sandboxUrl = failoverAntigravityUrl(url, this.baseUrl);
        if (sandboxUrl !== undefined) {
          response = await attempt(sandboxUrl);
        }
      }
      if (!response.ok) throw await mapUpstreamHttpError(response, "antigravity");
      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body.
      lifecycle.release();

      if (!request.stream) {
        const json = (await response.json()) as Record<string, unknown>;
        const { response: decoded, candidate: cand, parts } =
          geminiCandidate(json);
        const output = responseParts(parts);
        let seq = 1;
        yield {
          type: "response_start",
          sequence_number: seq++,
          model: request.model,
        } as CanonicalEvent;
        if (output.thought) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: {
              kind: "reasoning",
              payload: null,
              summary: output.thought,
            },
          } as CanonicalEvent;
        }
        if (output.text) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: output.text },
          } as CanonicalEvent;
        }
        for (const call of output.calls) {
          yield {
            type: "tool_call_delta",
            sequence_number: seq++,
            call_id: call.id,
            name: call.name,
            arguments_delta: JSON.stringify(call.args),
          } as CanonicalEvent;
        }
        const usageRec = usageFromProvider(mapGeminiUsage(decoded));
        const finishReason =
          typeof cand["finishReason"] === "string"
            ? (cand["finishReason"] as string)
            : undefined;
        if (typeof decoded["responseId"] === "string") {
          sessionState.lastExecutionId = decoded["responseId"] as string;
        }
        yield {
          type: "terminal",
          sequence_number: seq++,
          // No finishReason on a full body means the upstream response was
          // truncated: never complete.
          state: finishReason === undefined ? "failed" : "complete",
          stop_reason: toCanonicalStop(finishReason, output.calls.length),
          ...(finishReason ? { provider_stop_reason: finishReason } : {}),
          usage: usageRec,
        } as CanonicalEvent;
        return;
      }

      if (!response.body) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          "antigravity returned empty stream",
          {},
          "upstream",
        );
      }
      let seq = 1;
      yield {
        type: "response_start",
        sequence_number: seq++,
        model: request.model,
      } as CanonicalEvent;
      const activeCalls = new Set<string>();
      let rawUsage: Record<string, unknown> | undefined;
      let finishReason: string | undefined;
      let toolCount = 0;
      for await (const sse of decodeSseEvents(
        response.body as ReadableStream<Uint8Array>,
        { signal: lifecycle.signal },
      )) {
        const data = sse.data.trim();
        if (data === "[DONE]") break;
        const parsed = decodeGeminiStreamEvent(data, "antigravity stream error");
        if (parsed === undefined) continue;
        const { response: decoded, candidate: cand, parts } = geminiCandidate(parsed);
        const output = responseParts(parts);
        if (output.thought) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: {
              kind: "reasoning",
              payload: null,
              summary: output.thought,
            },
          } as CanonicalEvent;
        }
        if (output.text) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: output.text },
          } as CanonicalEvent;
        }
        for (const call of output.calls) {
          if (!activeCalls.has(call.id)) {
            activeCalls.add(call.id);
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              call_id: call.id,
              name: call.name,
              arguments_delta: "",
            } as CanonicalEvent;
          }
          const argsText = JSON.stringify(call.args);
          if (argsText !== "{}") {
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              call_id: call.id,
              arguments_delta: argsText,
            } as CanonicalEvent;
          }
          toolCount++;
        }
        if (isRecord(decoded["usageMetadata"])) {
          rawUsage = decoded["usageMetadata"] as Record<string, unknown>;
        }
        if (typeof decoded["responseId"] === "string") {
          sessionState.lastExecutionId = decoded["responseId"] as string;
        }
        if (typeof cand["finishReason"] === "string") {
          finishReason = cand["finishReason"] as string;
        }
      }
      const usageRec = usageFromProvider(
        rawUsage ? mapGeminiUsage({ usageMetadata: rawUsage }) : undefined,
      );
      if (context.abort_signal.aborted || finishReason === undefined) {
        yield {
          type: "terminal",
          sequence_number: seq++,
          // No finishReason means the stream ended without a terminal
          // chunk: truncated, never complete.
          state: finishReason === undefined ? "failed" : "aborted",
          stop_reason: toCanonicalStop(finishReason, toolCount),
          ...(finishReason ? { provider_stop_reason: finishReason } : {}),
          usage: usageRec,
        } as CanonicalEvent;
      } else {
        yield {
          type: "terminal",
          sequence_number: seq++,
          state: "complete",
          stop_reason: toCanonicalStop(finishReason, toolCount),
          ...(finishReason ? { provider_stop_reason: finishReason } : {}),
          usage: usageRec,
        } as CanonicalEvent;
      }
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      if (lifecycle.signal.aborted || (err as Error).name === "AbortError") {
        throw new GatewayError("transport_closed", 499, "request was cancelled");
      }
      throw err;
    } finally {
      lifecycle.release();
    }
  }
}

function toCanonicalStop(
  finishReason: string | undefined,
  toolCount: number,
): CanonicalStopReason {
  const map: Record<string, CanonicalStopReason> = {
    MAX_TOKENS: "length",
    STOP: "stop",
    SAFETY: "content_filter",
  };
  if (finishReason && map[finishReason]) return map[finishReason]!;
  return toolCount > 0 ? "tool_use" : "stop";
}

/**
 * Per-conversation upstream session. Created once per (conversation, model)
 * and sticky across turns so every turn looks like the same client instead
 * of a brand-new one: stable agent/trajectory/session ids, an incrementing
 * step index, and the previous turn's execution id echoed back.
 */
export interface AntigravitySessionState {
  agentId?: string;
  trajectoryId?: string;
  sessionId?: string;
  stepIndex?: number;
  lastExecutionId?: string;
}

/** Maximum in-memory conversation sessions retained by the adapter. */
const MAX_SESSION_STATES = 256;
const DEFAULT_SESSION_STATE_IDLE_TTL_MS = 30 * 60_000;

function sessionIdentityDigest(value: string): string {
  let hash = 1469598103934665603n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Bounded in-process conversation store keyed by route identity. Idle
 * entries expire, recency refreshes on access, and the oldest entry is
 * evicted at the cap so a fan-out over conversations cannot pin memory.
 * A dedicated class (rather than the shared TTL cache) because session
 * stickiness needs touch-on-read idle semantics plus prefix-scoped reset.
 */
export class AntigravitySessionStore {
  private readonly entries = new Map<string, { state: AntigravitySessionState; at: number }>();
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; idleTtlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? MAX_SESSION_STATES;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_SESSION_STATE_IDLE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Number of live entries. */
  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /** Returns the live state for key, creating it when absent or expired. */
  getOrCreate(key: string): AntigravitySessionState {
    this.evictExpired();
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.at = this.now();
      return existing.state;
    }
    const state: AntigravitySessionState = {};
    this.entries.set(key, { state, at: this.now() });
    this.evictOverCap();
    return state;
  }

  /** Deletes every entry whose key starts with prefix (except `keep`); returns the count. */
  resetByPrefix(prefix: string, keep?: string): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && key !== keep) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.idleTtlMs) this.entries.delete(key);
    }
  }

  private evictOverCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Negative signed session id, matching the captured client shape:
 * `"-" + (sha256(first-user-text)[0:8] & INT63 | random <9e18)`.
 * A positive or hyphenated-UUID value here is a one-glance synthetic signal.
 */
export function signedAntigravitySessionId(seed?: string): string {
  if (seed !== undefined && /^-?\d+$/.test(seed)) return seed;
  const text = seed !== undefined && seed.length > 0 ? seed : randomUUID();
  const head = BigInt(`0x${createHash("sha256").update(text).digest("hex").slice(0, 8)}`);
  const randomPart =
    BigInt(`0x${randomBytes(8).toString("hex")}`) % BigInt("9000000000000000000");
  const combined = (head & BigInt("0x7FFFFFFFFFFFFFFF")) | randomPart;
  return `-${combined.toString()}`;
}

/** Thinking budget per wire model, matching the client's effort tiers. */
export function antigravityThinkingBudget(modelId: string): number | undefined {
  if (!modelId.includes("claude") && !modelId.includes("gemini-3")) return undefined;
  if (modelId.endsWith("-low")) return 1_000;
  if (modelId.endsWith("-medium")) return 4_000;
  if (modelId.endsWith("-high")) return 10_000;
  return modelId.includes("3.1-pro") ? 10_001 : 10_000;
}

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

function sessionStateKey(routeIdentity: string, wireModelId: string): string {
  return `${sessionIdentityDigest(routeIdentity)}:antigravity:${wireModelId}`;
}

/** Statuses worth one bounded sandbox failover (throttled or server-side). */
function isFailoverStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Sandbox twin of a production Antigravity URL, or undefined when the base
 * is already custom (only the known production host has a sandbox twin).
 */
export function failoverAntigravityUrl(url: string, baseUrl: string): string | undefined {
  if (!baseUrl.includes("daily-cloudcode-pa.googleapis.com")) return undefined;
  const sandboxBase = baseUrl.replace(
    "daily-cloudcode-pa.googleapis.com",
    "daily-cloudcode-pa.sandbox.googleapis.com",
  );
  return url.startsWith(baseUrl) ? `${sandboxBase}${url.slice(baseUrl.length)}` : undefined;
}

/**
 * Wraps the shared Gemini payload in the Antigravity agent envelope.
 * Antigravity's `daily-cloudcode-pa` exposes the fixed
 * `v1internal:streamGenerateContent` / `v1internal:generateContent` RPC
 * (no per-model URL path): the resolved wire model id travels here as the
 * envelope `model`, while the Gemini `contents`/`tools`/`generationConfig`
 * ride inside `request` with Antigravity's `labels` telemetry.
 */
function buildAntigravityEnvelope(
  request: CanonicalRequest,
  projectId: string | undefined,
  wireModelId: string,
  logicalModelId: string,
  state: AntigravitySessionState,
  sessionSeed: string,
): Record<string, unknown> {
  const geminiPayload = buildGeminiPayload(request);
  const profile = getAntigravityModelWireProfile(wireModelId);

  const generationConfig = isRecord(geminiPayload["generationConfig"])
    ? (geminiPayload["generationConfig"] as Record<string, unknown>)
    : {};
  if (profile) {
    generationConfig["maxOutputTokens"] = profile.maxOutputTokens;
  }
  const budget = antigravityThinkingBudget(wireModelId);
  if (budget !== undefined) {
    generationConfig["thinkingConfig"] = { includeThoughts: true, thinkingBudget: budget };
  }

  state.agentId ??= randomUUID();
  state.trajectoryId ??= randomUUID();
  state.sessionId ??= signedAntigravitySessionId(sessionSeed);
  state.stepIndex = (state.stepIndex ?? 1) + 1;
  const step = state.stepIndex;

  const labels: Record<string, string> = {
    ...(state.lastExecutionId ? { last_execution_id: state.lastExecutionId } : {}),
    trajectory_id: state.trajectoryId,
    last_step_index: String(step - 1),
    used_claude: String(logicalModelId.includes("claude")),
    used_claude_conservative: String(logicalModelId.includes("claude")),
  };
  if (profile?.modelEnum) {
    labels["model_enum"] = profile.modelEnum;
  }

  const existingContents = Array.isArray(geminiPayload["contents"])
    ? (geminiPayload["contents"] as Record<string, unknown>[])
    : [];
  const injectIdentity =
    logicalModelId.toLowerCase().includes("claude") || logicalModelId.toLowerCase().includes("gemini-3");
  // Identity rides the dedicated systemInstruction field (captured shape),
  // never a fake user turn: a fabricated history turn pollutes multi-turn
  // context, while systemInstruction stays out of the conversation.
  const existingInstruction = isRecord(geminiPayload["systemInstruction"])
    ? (geminiPayload["systemInstruction"] as Record<string, unknown>)
    : undefined;
  const existingParts = Array.isArray(existingInstruction?.["parts"])
    ? (existingInstruction?.["parts"] as Record<string, unknown>[])
    : [];
  const hasIdentity = existingParts.some(
    (part) => isRecord(part) && part["text"] === ANTIGRAVITY_SYSTEM_INSTRUCTION,
  );
  const systemInstruction =
    !injectIdentity || hasIdentity
      ? existingInstruction
      : {
          role: "user",
          parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...existingParts],
        };

  const requestPayload: Record<string, unknown> = {
    ...geminiPayload,
    contents: existingContents,
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
    labels,
    sessionId: state.sessionId,
    ...(Object.keys(generationConfig).length > 0
      ? { generationConfig }
      : {}),
  };
  if ((request.tools ?? []).some((tool) => tool.name === "web_search" || tool.name === "web_search_preview")) {
    const tools = Array.isArray(requestPayload["tools"])
      ? [...(requestPayload["tools"] as Record<string, unknown>[])]
      : [];
    tools.push({ googleSearch: {} });
    requestPayload["tools"] = tools;
  }
  if (logicalModelId.includes("claude") && !isRecord(requestPayload["toolConfig"])) {
    requestPayload["toolConfig"] = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  applySkipThoughtSignatureBypass(requestPayload, logicalModelId);

  const envelope: Record<string, unknown> = {
    requestId: `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${step}`,
    model: wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    request: requestPayload,
  };
  if (projectId) {
    envelope["project"] = projectId;
  }
  return envelope;
}

export function createAntigravityAdapter(
  options: AntigravityAdapterOptions = {},
): ProviderAdapter {
  return new AntigravityAdapter(options);
}

export const antigravityAdapter: ProviderAdapter = createAntigravityAdapter();

export { AntigravityAdapter };
