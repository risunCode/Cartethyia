// Kiro (CodeWhisperer) adapter.
//
// Kiro does not speak a chat-shaped protocol: a request is a `conversationState`
// ledger, and the answer is an AWS EventStream binary frame sequence. The
// adapter therefore bypasses the canonical codecs entirely (`bespokeWire` in the
// provider metadata) and does the translation itself, in the modules beside it.
//
// Two upstream behaviours drive the header and endpoint logic:
//
//  * There is exactly one generation surface, `q.{region}.amazonaws.com`. The
//    legacy `codewhisperer.*` host and the vendor's own path-style gateway are
//    not what the real client talks to, and reaching for them is actively
//    harmful: an account that has just been refused would immediately probe two
//    other service entries with the same token, which is the shape of credential
//    probing rather than of a client retrying. A refusal is reported, never
//    replayed onto another host.
//  * Every request carries a device identity (`KiroIDE-{version}-{machineId}`
//    in the User-Agent) and closes its connection. A connection reused across
//    accounts lets one TCP session carry several tokens that each claim to be a
//    different machine — the strongest possible evidence of sharing. An account
//    whose machine id cannot be derived is refused rather than dispatched with a
//    constant or a per-request random value.
//
// The profile ARN is never manufactured: an account that resolved none sends
// none. The shared placeholder belongs to the vendor's own account and the
// upstream answers it with 403.

import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  UsageRecord,
} from "../../../transport/canonical-model";
import { GatewayError } from "../../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";
import {
  buildKiroAmzUserAgent,
  buildKiroUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { FrameBuffer } from "../connect";
import { decodeEventStreamMessages } from "./aws-event-stream";
import {
  buildKiroWireRequest,
  generateKiroConversationId,
  kiroThinkingBudgetForEffort,
  type KiroWireRequest,
} from "./kiro-request";
import { machineIdForAuthState } from "./kiro-machine-id";
import { resolveKiroProfileArn } from "./kiro-profile";
import { kiroContextWindow } from "./kiro-catalog";
import { resolveInboundSessionId } from "../../operations/session-resolution";
import { KiroStreamDecoder, isKiroTruncationReason, type KiroUsage } from "./kiro-stream";

/** Provider id this adapter registers under. */
export const KIRO_PROVIDER_ID = "kiro";

/** Longest single message this adapter will buffer before treating the stream as corrupt. */
const KIRO_MAX_STREAM_BUFFER_BYTES = 24 * 1024 * 1024;

/** Response header the upstream sets on a streaming answer. */
const KIRO_STREAM_ACCEPT = "application/vnd.amazon.eventstream";

/** Non-secret per-account auth configuration, as stored on the account. */
interface KiroAuthState {
  readonly authMethod: string;
  readonly region: string;
  readonly profileArn?: string;
  readonly machineId?: string;
}

/** AWS region shape, checked before a region is interpolated into a URL. */
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

interface KiroAdapterOptions {
  readonly fetch?: typeof fetch;
}

/** Reads the account's stored auth configuration, or `undefined` when absent. */
function readAuthState(context: ProviderDispatchContext): KiroAuthState | undefined {
  const raw = context.credential.auth_state;
  if (raw === undefined) return undefined;
  const authMethod = typeof raw["authMethod"] === "string" ? raw["authMethod"] : undefined;
  if (authMethod === undefined) return undefined;
  const region = typeof raw["region"] === "string" && raw["region"].trim().length > 0 ? raw["region"].trim() : "us-east-1";
  const profileArn = typeof raw["profileArn"] === "string" && raw["profileArn"].trim().length > 0 ? raw["profileArn"].trim() : undefined;
  const machineId = typeof raw["machineId"] === "string" && raw["machineId"].trim().length > 0 ? raw["machineId"].trim() : undefined;
  return {
    authMethod,
    region,
    ...(profileArn === undefined ? {} : { profileArn }),
    ...(machineId === undefined ? {} : { machineId }),
  };
}

/**
 * The conversation id this request carries.
 *
 * The upstream scopes its prompt cache to this id, so a value that changes per
 * request means no turn of a conversation can ever reuse the previous turn's
 * work — the ledger is re-read in full every time, which is both slower and more
 * expensive. A client that sends its own id keeps it; one that sends none gets
 * the affinity key derived from its opening turn, which is stable across the
 * turns of that conversation. Only a request with no derivable opening turn —
 * no session header, no conversation id, and no opening text — falls back to a
 * fresh id, because there is nothing to be stable about.
 *
 * This is the same resolution every other session-scoped adapter uses; a private
 * `randomUUID()` here was what made Kiro the one provider that never cached.
 */
function resolveKiroConversationId(
  request: CanonicalRequest,
  context: ProviderDispatchContext,
): string {
  return (
    request.conversation?.conversation_id ??
    request.conversation_id ??
    resolveInboundSessionId(context, request) ??
    generateKiroConversationId()
  );
}

/**
 * The profile ARN this request carries, or `""` when it carries none.
 *
 * The generation surface is profile-scoped and refuses the field's absence
 * (`400 profileArn is required for this request.`), so the account's own profile
 * is used when its sign-in resolved one and the sign-in family's public default
 * otherwise. The resolution — including which families are credential-scoped and
 * must never receive a default — lives in `kiro-profile.ts`, shared with the
 * usage and catalog surfaces so all three scope a request identically.
 */
function resolveProfileArn(context: ProviderDispatchContext): string {
  return resolveKiroProfileArn(context.credential.auth_state);
}

/**
 * Resolves the device identity this request presents.
 *
 * The login flows freeze this into `auth_state`, derived from material that
 * outlives a token rotation. Dispatch sees only the *access* token, which is
 * replaced on every refresh, so it must never derive from that: an account whose
 * device id moved on every refresh is the exact defect this exists to prevent.
 * An account that predates the field falls back to its own account id, which is
 * stable for the life of the row and distinct between accounts.
 */
function resolveAccountMachineId(context: ProviderDispatchContext): string {
  return machineIdForAuthState(context.credential.auth_state, context.credential.account_id);
}

/** Region validated before interpolation into an endpoint URL. */
function safeRegion(authState: KiroAuthState | undefined): string {
  const region = authState?.region ?? "us-east-1";
  return AWS_REGION_PATTERN.test(region) ? region : "us-east-1";
}

/**
 * The single generation endpoint this adapter posts to.
 *
 * There is no fallback host: see the module header for why a refusal must not be
 * replayed onto another service entry.
 */
export function kiroEndpoint(authState: KiroAuthState | undefined): string {
  return `https://q.${safeRegion(authState)}.amazonaws.com/generateAssistantResponse`;
}

/**
 * Builds the request headers.
 *
 * Every field is load-bearing on the observed client's wire:
 *
 *  * `connection: close` — one request per connection, so a single TCP session
 *    never carries two accounts' tokens.
 *  * `user-agent` / `x-amz-user-agent` — the SDK identity plus the
 *    `KiroIDE-{version}-{machineId}` device marker the upstream correlates on.
 *  * `x-amzn-codewhisperer-optout` — the observed client opts out of data
 *    collection on every generation request.
 *  * `x-amzn-kiro-agent-mode` — the agent mode the observed client declares.
 *  * `tokentype` — an API key or enterprise token is rejected as an OAuth access
 *    token unless it is labelled as one.
 */
export function kiroHeaders(
  secret: string,
  authState: KiroAuthState | undefined,
  machineId: string,
): Record<string, string> {
  const authMethod = authState?.authMethod;
  const version = getKiroVersion();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: KIRO_STREAM_ACCEPT,
    connection: "close",
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "spec",
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "user-agent": buildKiroUserAgent(version, machineId),
    "x-amz-user-agent": buildKiroAmzUserAgent(version, machineId),
    authorization: `Bearer ${secret}`,
  };
  if (authMethod === "api_key") {
    headers["tokentype"] = "API_KEY";
  } else if (authMethod === "external_idp") {
    headers["tokentype"] = "EXTERNAL_IDP";
  }
  return headers;
}

/**
 * Builds the canonical usage record from what the upstream reported.
 *
 * The upstream sends no token field at all — only `contextUsageEvent`, whose
 * `contextUsagePercentage` is the share of the model's window this turn occupies,
 * and `meteringEvent`, whose `usage` is billed credits. The percentage is a real
 * upstream measurement rather than an estimate of ours: feeding it two payloads
 * of identical length but different token density (repetitive prose vs random
 * alphanumerics) moves it 4.25% -> 9.68%, so it tracks tokens and not bytes.
 *
 * A token count is therefore recovered by scaling that percentage by the model's
 * window. The percentage covers the whole turn — prompt plus completion — so the
 * completion side is subtracted out of it, and only that subtraction needs an
 * estimate: the upstream never says how long its own answer was, so the emitted
 * text is counted at the usual ~4 characters per token.
 */
function kiroUsage(usage: KiroUsage, modelId: string, outputText: string): UsageRecord {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  // An explicit token field always wins: it is the upstream stating the number
  // rather than us recovering it. No event observed from this surface carries
  // one, but a `metricsEvent` that did would be authoritative.
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    return {
      input_tokens: input,
      cached_input_tokens: cacheRead > 0 ? cacheRead : "unavailable",
      cache_write_tokens: cacheWrite > 0 ? cacheWrite : "unavailable",
      uncached_input_tokens: cacheRead > 0 ? Math.max(0, input - cacheRead) : "unavailable",
      output_tokens: output,
      reasoning_tokens: "unavailable",
      estimated_cost: null,
      total_tokens: input + output,
      ...(usage.credits === undefined ? {} : { credit_used: usage.credits }),
    };
  }
  const completionTokens = outputText.length === 0 ? 0 : Math.max(1, Math.floor(outputText.length / 4));
  const percentage = usage.contextUsagePercentage;
  const measuredTotal =
    percentage === undefined || percentage <= 0
      ? undefined
      : Math.round((kiroContextWindow(modelId) * percentage) / 100);
  const input = measuredTotal === undefined ? 0 : Math.max(0, measuredTotal - completionTokens);
  const output = measuredTotal === undefined ? 0 : completionTokens;
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead > 0 ? cacheRead : "unavailable",
    cache_write_tokens: cacheWrite > 0 ? cacheWrite : "unavailable",
    uncached_input_tokens: cacheRead > 0 ? Math.max(0, input - cacheRead) : "unavailable",
    output_tokens: output,
    // Reasoning is billed as output, and the upstream reports no split for it,
    // so no separate figure is invented here.
    reasoning_tokens: "unavailable",
    // Unpriced until the dispatch call site reprices against the routed model.
    estimated_cost: null,
    total_tokens: input + output,
    ...(usage.credits === undefined ? {} : { credit_used: usage.credits }),
  };
}

/**
 * Chooses the reasoning effort field this model accepts, or `undefined`.
 *
 * The two schemas upstream are not interchangeable and the older models accept
 * neither, so the decision is made from the model id rather than defaulting:
 * a wrong choice is a rejected request, not a degraded one.
 */
export function kiroEffortPath(modelId: string): "output_config" | "reasoning" | undefined {
  const normalized = modelId.toLowerCase().replace(/-/g, ".");
  if (/(?:^|[/.])gpt[/.]5[/.]6(?:[/.]|$)/.test(normalized)) return "reasoning";
  if (!normalized.includes("claude")) return undefined;
  const match = normalized.match(/(?:^|[/.])claude(?:[/.][a-z]+)*[/.](\d+)(?:[/.](\d+))?(?:[/.]|$)/);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minorText = match[2];
  const minor = minorText === undefined ? null : Number(minorText);
  // The 4.5 generation rejects the field outright; a date-style suffix is a
  // newer model than its major.minor implies.
  if (major < 4) return undefined;
  if (major === 4 && (minor === null || minor <= 5 || minor >= 1000)) return undefined;
  return "output_config";
}

class KiroAdapter implements ProviderAdapter {
  readonly provider_id = KIRO_PROVIDER_ID;
  readonly #fetch: typeof fetch;

  constructor(options: KiroAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const secret = context.credential.secret
      ? new TextDecoder().decode(context.credential.secret).trim()
      : "";
    if (secret.length === 0) {
      throw new GatewayError("authentication_failed", 401, "Missing Kiro credential", {
        providerId: KIRO_PROVIDER_ID,
      });
    }

    const authState = readAuthState(context);
    const modelId = candidate.model_id || request.model;
    const effortPath = kiroEffortPath(modelId);
    // `none` is the canonical spelling of "do not reason"; it is not a tier the
    // upstream accepts, so it selects no effort field rather than being sent.
    const requestedEffort = request.reasoning?.effort;
    const effort =
      effortPath === undefined || requestedEffort === undefined || requestedEffort === "none"
        ? undefined
        : requestedEffort;
    // A model with no native effort field is asked to think through the text
    // marker instead, so an effort the caller requested still reaches it. Without
    // this the marker was only ever sent for an explicit `budget_tokens`, and a
    // caller asking for `high` on such a model got no thinking at all: the
    // request succeeded, the answer simply never reasoned.
    const thinkingBudget =
      effortPath !== undefined
        ? undefined
        : (request.reasoning?.budget_tokens ?? kiroThinkingBudgetForEffort(requestedEffort));
    const built = buildKiroWireRequest(request, {
      conversationId: resolveKiroConversationId(request, context),
      modelId,
      profileArn: resolveProfileArn(context),
      ...(effortPath === undefined || effort === undefined ? {} : { effortPath, effort }),
      ...(thinkingBudget === undefined ? {} : { thinkingBudget }),
    });
    if (!built.ok) {
      // The upstream answers this class of body with a terminal 400 that cools
      // the account, so it is refused here instead of being sent.
      throw new GatewayError(
        "invalid_request",
        400,
        "Kiro cannot accept this conversation",
        { providerId: KIRO_PROVIDER_ID, problems: built.error.problems },
      );
    }

    const fetchFn = (context.outbound_fetch as unknown as typeof fetch | undefined) ?? this.#fetch;
    const body = JSON.stringify(built.value.payload);
    const machineId = resolveAccountMachineId(context);
    const response = await this.#send(
      fetchFn,
      kiroEndpoint(authState),
      body,
      context,
      secret,
      authState,
      machineId,
    );
    if (!response.body) {
      throw new GatewayError("platform_unavailable", 502, "Kiro returned an empty body", {
        providerId: KIRO_PROVIDER_ID,
      }, "upstream");
    }

    yield* this.#stream(response.body, built.value, request);
  }

  /**
   * Posts the one request this adapter makes.
   *
   * There is no failover: a refusal from the generation surface is reported as
   * it is. Replaying it onto another host would turn one refusal into a scan of
   * every service entry with the same token, which is the behaviour the upstream
   * reads as credential probing.
   */
  async #send(
    fetchFn: typeof fetch,
    url: string,
    body: string,
    context: ProviderDispatchContext,
    secret: string,
    authState: KiroAuthState | undefined,
    machineId: string,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: kiroHeaders(secret, authState, machineId),
        body,
        signal: context.abort_signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayError("transport_closed", 499, "request was cancelled", {
          providerId: KIRO_PROVIDER_ID,
        });
      }
      throw new GatewayError(
        "transport_unavailable",
        502,
        `Kiro transport failed: ${error instanceof Error ? error.message : String(error)}`,
        { providerId: KIRO_PROVIDER_ID },
        "network",
      );
    }
    if (response.ok) return response;
    throw await mapUpstreamHttpError(response, KIRO_PROVIDER_ID);
  }

  /**
   * Translates the upstream EventStream into canonical events.
   *
   * Events are emitted as they arrive rather than buffered: the client's
   * time-to-first-token is the whole reason the surface is streamed, and nothing
   * here needs the complete answer to decide anything.
   */
  async *#stream(
    stream: ReadableStream<Uint8Array>,
    built: KiroWireRequest,
    request: CanonicalRequest,
  ): AsyncIterable<CanonicalEvent> {
    const decoder = new KiroStreamDecoder();
    const reader = stream.getReader();
    const pending = new FrameBuffer();
    let sequence = 0;
    let stopReason: CanonicalStopReason | undefined;
    let providerStopReason: string | undefined;
    let usage: KiroUsage = {};
    let sawToolCall = false;
    // Output length is counted because the upstream reports no completion-token
    // field at all; see `kiroUsage` for how it is combined with the context
    // percentage the upstream does report.
    let outputText = "";

    yield { type: "response_start", sequence_number: sequence++, model: request.model };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value !== undefined && value.byteLength > 0) {
          if (pending.view().byteLength + value.byteLength > KIRO_MAX_STREAM_BUFFER_BYTES) {
            throw new GatewayError(
              "platform_unavailable",
              502,
              "Kiro EventStream exceeded the buffer bound",
              { providerId: KIRO_PROVIDER_ID },
              "upstream",
            );
          }
          pending.append(value);
        }
        const buffered = pending.view();
        const decoded = decodeEventStreamMessages(buffered);
        if (decoded.failure !== undefined) {
          throw new GatewayError(
            "platform_unavailable",
            502,
            `Kiro EventStream is corrupt: ${decoded.failure.detail}`,
            { providerId: KIRO_PROVIDER_ID, reason: decoded.failure.reason },
            "upstream",
          );
        }
        pending.consume(decoded.consumed);
        for (const message of decoded.messages) {
          const outcome = decoder.decode(message);
          if (outcome.failure !== undefined) {
            throw new GatewayError("platform_unavailable", 502, outcome.failure.message, {
              providerId: KIRO_PROVIDER_ID,
            }, "upstream");
          }
          if (outcome.providerStopReason !== undefined) providerStopReason = outcome.providerStopReason;
          if (outcome.stopReason !== undefined) {
            stopReason = mergeStopReason(stopReason, outcome.stopReason);
          }
          for (const delta of outcome.deltas) {
            switch (delta.kind) {
              case "text":
                outputText += delta.text;
                yield {
                  type: "content_delta",
                  sequence_number: sequence++,
                  content: { kind: "text", text: delta.text },
                };
                break;
              case "reasoning":
                // Reasoning is output the model generated and is billed as
                // such, so it counts toward the completion side.
                outputText += delta.text;
                yield {
                  type: "content_delta",
                  sequence_number: sequence++,
                  content: { kind: "reasoning", payload: null, summary: delta.text },
                };
                break;
              case "tool_call": {
                sawToolCall = true;
                const name = built.toolNameMap.get(delta.name) ?? delta.name;
                outputText += delta.arguments_delta;
                yield {
                  type: "tool_call_delta",
                  sequence_number: sequence++,
                  call_id: delta.call_id,
                  name,
                  ...(delta.arguments_delta.length > 0 ? { arguments_delta: delta.arguments_delta } : {}),
                };
                break;
              }
              case "usage":
                usage = { ...usage, ...delta.usage };
                break;
            }
          }
        }
        if (done) break;
      }

      // Text held back for a possible split marker is real output at EOF.
      for (const delta of decoder.flush()) {
        if (delta.kind === "text") {
          outputText += delta.text;
          yield {
            type: "content_delta",
            sequence_number: sequence++,
            content: { kind: "text", text: delta.text },
          };
        } else if (delta.kind === "reasoning") {
          outputText += delta.text;
          yield {
            type: "content_delta",
            sequence_number: sequence++,
            content: { kind: "reasoning", payload: null, summary: delta.text },
          };
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof GatewayError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayError("transport_closed", 499, "request was cancelled", {
          providerId: KIRO_PROVIDER_ID,
        });
      }
      throw new GatewayError(
        "platform_unavailable",
        502,
        `Kiro stream failed: ${error instanceof Error ? error.message : String(error)}`,
        { providerId: KIRO_PROVIDER_ID },
        "upstream",
      );
    } finally {
      reader.releaseLock();
    }

    const finalUsage = kiroUsage(usage, request.model, outputText);
    yield {
      type: "usage",
      sequence_number: sequence++,
      usage: finalUsage,
    };
    yield {
      type: "terminal",
      sequence_number: sequence++,
      state: "complete",
      stop_reason: resolveFinalStopReason(stopReason, providerStopReason, sawToolCall),
      ...(providerStopReason === undefined ? {} : { provider_stop_reason: providerStopReason }),
      usage: finalUsage,
    };
  }
}

/**
 * Keeps the more severe of two stop reasons.
 *
 * The upstream can report one in the stop event and another in the metadata
 * event, and they disagree when a turn was cut short after emitting output.
 * A truncation or a tool call is more informative than a clean finish, so the
 * reasons are ranked rather than overwritten by arrival order.
 */
function mergeStopReason(
  current: CanonicalStopReason | undefined,
  next: CanonicalStopReason,
): CanonicalStopReason {
  const severity = (reason: CanonicalStopReason | undefined): number => {
    if (reason === undefined) return 0;
    if (reason === "refusal") return 6;
    if (reason === "length") return 5;
    if (reason === "tool_use") return 4;
    if (reason === "stop") return 3;
    return 1;
  };
  return severity(next) >= severity(current) ? next : current ?? next;
}

/**
 * Decides the canonical stop reason for the finished stream.
 *
 * A tool call that streamed without an explicit stop still means `tool_use`, and
 * an unrecognized upstream reason falls back to `stop` only when nothing else
 * explains the turn — the raw value rides along in `provider_stop_reason` so the
 * unknown case stays visible rather than being erased.
 */
function resolveFinalStopReason(
  stopReason: CanonicalStopReason | undefined,
  providerStopReason: string | undefined,
  sawToolCall: boolean,
): CanonicalStopReason {
  if (stopReason === "length" || isKiroTruncationReason(providerStopReason)) return "length";
  if (stopReason === "tool_use" || sawToolCall) return "tool_use";
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "refusal") return "refusal";
  return "stop";
}

/** Builds the adapter. */
export function createKiroAdapter(options: KiroAdapterOptions = {}): ProviderAdapter {
  return new KiroAdapter(options);
}

export const kiroAdapter: ProviderAdapter = createKiroAdapter();

/** Base URL this provider registers, used by the metadata layer. */
export const KIRO_BASE_URL = providerBaseUrl(KIRO_PROVIDER_ID);
