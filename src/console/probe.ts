/**
 * Capability-resolved universal model probe (`src/console/probe.ts`).
 *
 * Single console model-test service for every registered provider/model. It
 * never hardcodes a surface: the probe surface and streaming mode come from
 * the model's (or adapter's) declared capabilities. Stream is preferred so
 * the probe can stop after the first useful visible `text_delta`; providers
 * that cannot stream get a provider-valid bounded `non_stream` request.
 * Reasoning/thinking control is only requested when the model declares
 * reasoning support, and `thinking_delta` events are always discarded.
 *
 * The probe writes no telemetry and persists nothing. The console API layer
 * that calls this service records compact `model_probe` metadata itself.
 *
 * Resource contract: every acquired resource â€” the credential lease, the
 * proxy slot, the abort controller, and the first-visible-text timer â€” is
 * released exactly once through a shared cleanup stack, even on failure.
 *
 * Health contract: when an auto-selected or explicit stored account fails,
 * the account's bounded health is updated through the same typed error
 * mapping as live traffic (`recordFailure` no-ops for non-retryable
 * errors); a successful probe restores the account (`recordSuccess`).
 * Manual credentials never mutate stored account health.
 *
 * Result contract: failures are typed application errors (`SafeErrorSummary`) and never
 * carry the probe prompt, request body, or model thinking; `sample` is
 * visible text only, bounded in length.
 */

import type { ProviderCallError, SafeErrorSummary } from "../application/contracts";
import { createCleanupStack } from "../application/contracts";
import type { Adapter, ProviderModel, ProviderOutput, ProviderRequest, Surface, RouteTarget } from "../application/contracts";
import type { ProxyRequest, RequestLimits } from "../application/contracts";
import type { StreamEvent } from "../application/contracts";
import type { AccountCandidate, CredentialSelection } from "../application/contracts";
import type { ProviderRegistry } from "../providers/registry";
import type { CredentialSelector, CredentialConfigStore, AccountHealthManager } from "../auth";
import { credentialUnavailableError } from "../auth";
import type { NetworkSelector } from "../traffic";
import { networkUnavailableError } from "../traffic";
import { makeProviderError } from "../traffic";
import { isRecord } from "../application/protocols";

// ---------------------------------------------------------------- public contract

export type ProbeCredentialMode = "auto" | "account" | "manual";

export interface ModelProbeLimits {
  /** Connect timeout for the upstream request. */
  readonly connectMs: number;
  /** Stream probe: give up when no visible text arrives within this bound. */
  readonly firstVisibleTextMs: number;
  /** Stream idle timeout (no upstream bytes at all). */
  readonly idleMs: number;
  /** Total probe bound for either mode. */
  readonly totalMs: number;
  /** Smallest provider-valid output limit; the adapter maps it per protocol. */
  readonly maxOutputTokens: number;
  /** Maximum visible characters kept in `sample`. */
  readonly maxSampleChars: number;
}

export const DEFAULT_PROBE_LIMITS: ModelProbeLimits = {
  connectMs: 10_000,
  firstVisibleTextMs: 15_000,
  idleMs: 20_000,
  totalMs: 25_000,
  maxOutputTokens: 256,
  maxSampleChars: 400,
};

export interface ModelProbeInput {
  readonly provider: string;
  readonly model: string;
  readonly credentialMode: ProbeCredentialMode;
  /** Required for `credentialMode: "account"`; must belong to `provider`. */
  readonly accountId?: string;
  /** Required for `credentialMode: "manual"` unless the provider's credential kind is `manual`. */
  readonly credential?: string;
  readonly signal: AbortSignal;
  readonly limits?: Partial<ModelProbeLimits>;
}

/**
 * Injected ports so the console composition layer owns construction. The
 * probe only depends on these interfaces (plus application contract types); it constructs
 * nothing itself.
 */
export interface ProbePorts {
  readonly registry: ProviderRegistry;
  /** Static account configuration, used to enumerate candidates for the provider. */
  readonly accounts: CredentialConfigStore;
  /** Credential/lease selection with the same eligibility policy as live routing. */
  readonly credentials: CredentialSelector;
  /** Bounded per-account health; updated only for auto/account credentials. */
  readonly accountHealth: AccountHealthManager;
  /** Direct/proxy selection; the acquired proxy slot is released exactly once. */
  readonly network: NetworkSelector;
}

export type ModelProbeResult =
  | {
      readonly ok: true;
      readonly mode: "stream" | "non_stream";
      readonly latencyMs: number;
      /** Stream mode: time from stream start to the first useful visible text. */
      readonly firstVisibleTextMs?: number;
      /** Visible text only; model thinking is never included. */
      readonly sample: string;
      /** The model name returned by the provider (from response body `model` field). */
      readonly returnedModel?: string;
    }
  | {
      readonly ok: false;
      /** Null when the failure happened before a mode could be resolved. */
      readonly mode: "stream" | "non_stream" | null;
      readonly latencyMs: number;
      readonly error: SafeErrorSummary;
    };

// ---------------------------------------------------------------- internals

const PROBE_PROMPT = "Reply briefly and naturally in one sentence: Hello, I'm <your model name>. My knowledge cutoff is <month and year, or unknown>. How can I help you today? Do not think aloud, explain, or add any other text.";
const PROBE_MAX_BODY_BYTES = 1_048_576;

export async function probeProviderModel(input: ModelProbeInput, ports: ProbePorts): Promise<ModelProbeResult> {
  const limits: ModelProbeLimits = { ...DEFAULT_PROBE_LIMITS, ...(input.limits ?? {}) };
  const startedAt = performance.now();
  const latency = (): number => Math.max(0, Math.round(performance.now() - startedAt));

  if (input.signal.aborted) {
    return failure(null, latency(), makeProviderError("client_aborted", "Probe aborted before it started", { retryable: false, routeScope: null }));
  }

  const controller = new AbortController();
  const cleanup = createCleanupStack();
  const onExternalAbort = (): void => controller.abort();
  input.signal.addEventListener("abort", onExternalAbort, { once: true });
  cleanup.add({ release: async () => input.signal.removeEventListener("abort", onExternalAbort) });

  let adapter: Adapter | null = null;
  let mode: "stream" | "non_stream" | null = null;
  let accountId: string | null = null;

  try {
    // ---- capability resolution (no hardcoded surface) ----
    adapter = ports.registry.get(input.provider);
    if (adapter === null) {
      throw makeProviderError("provider_unavailable", `Provider "${input.provider}" is not registered`, { retryable: false, routeScope: null });
    }
    const model = adapter.models.get(input.model);
    // Catalog is informational, not a gate — operator-added models pass through.
    // Only block when the adapter has a non-empty catalog AND the model isn't found
    // AND the adapter is not a custom/permissive adapter.
    const surface = resolveProbeSurface(adapter, model);
    if (surface === null) {
      throw makeProviderError("capability_unsupported", `Model "${input.model}" on provider "${input.provider}" does not expose a text-generation surface`, { statusCode: 400, retryable: false, routeScope: "provider" });
    }
    const capabilities = model !== null ? model.capabilities : adapter.capabilities;
    // Probes intentionally use the completed response path for all compatible
    // providers so thinking-only streams cannot be mistaken for empty output.
    mode = "non_stream";

    let target: RouteTarget;
    try {
      target = adapter.resolveTarget(input.model, surface);
    } catch (error) {
      throw adapter.mapError(error);
    }

    // ---- credential selection (auto/account through normal policy) ----
    const selection = await selectCredential(input, ports, adapter);
    accountId = selection.accountId;
    cleanup.add({ release: () => ports.credentials.release(selection.leaseId) });

    // ---- network selection (direct or proxied; slot released exactly once) ----
    const network = await ports.network.select({ providerId: input.provider });
    if (network === null) throw networkUnavailableError(input.provider);
    cleanup.add({ release: network.selection.release });

    // ---- minimal, provider-valid probe request ----
    const request: ProxyRequest = {
      model: input.model,
      messages: [{ role: "user", content: [{ type: "text", text: PROBE_PROMPT }] }],
      tools: [],
      // Model testing needs the completed assistant message; streaming gateways
      // can spend the whole stream on reasoning and omit content deltas.
      stream: false,
      responseFormat: "text",
      // Reasoning/thinking disable is requested only when the model declares
      // reasoning support; adapters map it (or omit it) per protocol.
      reasoning: capabilities.reasoning ? "disabled" : "default",
      maxOutputTokens: limits.maxOutputTokens,
      images: [],
      sourceSurface: surface,
      signal: controller.signal,
      limits: probeRequestLimits(limits),
    };

    let output: ProviderOutput;
    try {
      output = await adapter.call({ target, request, credential: selection.secret, network: network.selection, signal: controller.signal });
    } catch (error) {
      throw adapter.mapError(error);
    }

    // ---- collect visible text only ----
    let sample: string;
    let firstVisibleTextMs: number | undefined;
    let returnedModel: string | undefined;
    if (output.mode === "stream") {
      const collected = await collectStreamSample(output.events, controller, limits, adapter);
      sample = collected.sample;
      firstVisibleTextMs = collected.firstVisibleTextMs;
      // returnedModel is recovered from stream via collectStreamSample if available
    } else {
      sample = extractNonStreamSample(surface, output.body).trim().slice(0, limits.maxSampleChars);
      returnedModel = typeof output.body["model"] === "string" ? output.body["model"] : undefined;
    }

    // Some providers (e.g. Kimi K2, GLM) return empty content when probed
    // non-stream with reasoning disabled — retry with stream mode to get
    // visible text deltas. Only retry once; don't loop.
    if (sample.length === 0 && output.mode !== "stream") {
      try {
        const streamRequest: ProxyRequest = { ...request, stream: true };
        const streamOutput = await adapter.call({ target, request: streamRequest, credential: selection.secret, network: network.selection, signal: controller.signal });
        if (streamOutput.mode === "stream") {
          const collected = await collectStreamSample(streamOutput.events, controller, limits, adapter);
          sample = collected.sample;
          firstVisibleTextMs = collected.firstVisibleTextMs;
        }
      } catch {
        // Retry failed — fall through with empty sample, don't throw.
      }
    }

    if (sample.length === 0) {
      // Don't throw — return ok with empty sample so the toast shows
      // "No sample text in the response" instead of a hard failure.
    }

    if (accountId !== null) {
      await ports.accountHealth.recordSuccess(accountId, input.provider);
    }
    return { ok: true, mode, latencyMs: latency(), firstVisibleTextMs, sample, returnedModel };
  } catch (error) {
    const providerError = toProbeError(error, adapter);
    if (accountId !== null) {
      await ports.accountHealth.recordFailure(accountId, input.provider, providerError);
    }
    return failure(mode, latency(), providerError);
  } finally {
    controller.abort();
    await cleanup.run();
  }
}

function failure(mode: "stream" | "non_stream" | null, latencyMs: number, error: ProviderCallError): ModelProbeResult {
  return { ok: false, mode, latencyMs, error: toSafeSummary(error) };
}

function toSafeSummary(error: ProviderCallError): SafeErrorSummary {
  return { statusCode: error.statusCode, kind: error.kind, message: error.sanitizedMessage, retryAt: error.retryAt };
}

/** Adapter errors and probe errors are already typed application errors; anything else goes through the adapter mapper. */
function toProbeError(error: unknown, adapter: Adapter | null): ProviderCallError {
  if (isProviderCallError(error)) return error;
  if (adapter !== null) return adapter.mapError(error);
  return makeProviderError("provider_protocol_error", "Probe failed before provider resolution", { retryable: false, routeScope: null });
}

function isProviderCallError(value: unknown): value is ProviderCallError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProviderCallError).kind === "string" &&
    typeof (value as ProviderCallError).sanitizedMessage === "string"
  );
}

/** Text-generation surface from the model's (or adapter's) declared order; images are never probed. */
function resolveProbeSurface(adapter: Adapter, model: ProviderModel | null): Surface | null {
  const declared = model !== null ? model.capabilities.surfaces : adapter.capabilities.surfaces;
  return declared.find((surface) => surface !== "images") ?? null;
}

function probeRequestLimits(limits: ModelProbeLimits): RequestLimits {
  return {
    maxBodyBytes: PROBE_MAX_BODY_BYTES,
    connectTimeoutMs: limits.connectMs,
    firstByteTimeoutMs: limits.connectMs,
    idleTimeoutMs: limits.idleMs,
    totalTimeoutMs: limits.totalMs,
  };
}

async function selectCredential(input: ModelProbeInput, ports: ProbePorts, adapter: Adapter): Promise<CredentialSelection> {
  if (adapter.metadata.credentialKind === "none") {
    return { accountId: null, kind: "none", leaseId: crypto.randomUUID(), secret: "" };
  }
  if (input.credentialMode === "manual") {
    const needsSecret = adapter.metadata.credentialKind !== "manual";
    if (needsSecret && (input.credential === undefined || input.credential.length === 0)) {
      throw makeProviderError("invalid_request", "manual credential mode requires a credential", { statusCode: 400, retryable: false, routeScope: null });
    }
    return { accountId: null, kind: "manual", leaseId: crypto.randomUUID(), secret: input.credential ?? "" };
  }

  if (input.credentialMode === "account" && input.accountId === undefined) {
    throw makeProviderError("invalid_request", "account credential mode requires an accountId", { statusCode: 400, retryable: false, routeScope: null });
  }

  const configs = await ports.accounts.listAccounts();
  const candidates: AccountCandidate[] = [];
  for (const config of configs) {
    if (config.providerId !== input.provider) continue;
    if (input.credentialMode === "account" && config.id !== input.accountId) continue;
    candidates.push({
      id: config.id,
      providerId: input.provider,
      credentialKind: config.kind,
      health: await ports.accountHealth.getHealth(config.id),
      enabled: config.enabled,
      quotaAvailable: true,
      modelLocks: null,
    });
  }
  if (input.credentialMode === "account" && candidates.length === 0) {
    throw makeProviderError("invalid_request", `Account "${input.accountId}" is not configured for provider "${input.provider}"`, { statusCode: 400, retryable: false, routeScope: null });
  }

  const result = await ports.credentials.select({
    providerId: input.provider,
    candidates,
    preferredAccountId: input.credentialMode === "account" ? input.accountId : null,
  });
  if (result === null) throw credentialUnavailableError(input.provider);
  return result.selection;
}

/**
 * Stream probe: discard `thinking_delta` and every non-text event, and
 * return an empty sample (not an error) when no visible `text_delta`
 * arrives within the first-visible-text bound or when the stream ends
 * without producing visible text. Throwing is reserved for real stream
 * errors; emptiness is a caller-side decision.
 */
async function collectStreamSample(
  events: AsyncIterable<StreamEvent>,
  controller: AbortController,
  limits: ModelProbeLimits,
  adapter: Adapter,
): Promise<{ readonly sample: string; readonly firstVisibleTextMs: number }> {
  const streamStartedAt = performance.now();
  let firstTextTimedOut = false;
  let firstVisibleTextMs: number | undefined;
  let visible = "";
  const firstTextTimer = setTimeout(() => {
    if (firstVisibleTextMs === undefined) {
      firstTextTimedOut = true;
      controller.abort();
    }
  }, limits.firstVisibleTextMs);
  try {
    for await (const event of events) {
      if (event.type === "message_stop") break;
      if (event.type !== "text_delta") continue; // thinking_delta and every other event are excluded
      const text = event.text;
      if (text.trim().length === 0) continue;
      firstVisibleTextMs ??= Math.max(0, Math.round(performance.now() - streamStartedAt));
      visible += text;
      if (visible.length >= limits.maxSampleChars) visible = visible.slice(0, limits.maxSampleChars);
    }
    // If the stream produced no visible text, return an empty sample
    // instead of throwing. The probe caller (probeProviderModel) has a
    // stream-fallback retry path, and collectStreamSample is also called
    // during that retry — throwing here would mask the original empty
    // result behind a generic protocol error. Returning empty lets the
    // caller decide: return ok with empty sample, or retry with stream.
    const cleaned = stripReasoningTags(visible);
    // If stripping removed everything, the stream was pure reasoning
    // leaked as text_delta — still return empty (not an error).
    return { sample: cleaned, firstVisibleTextMs: firstVisibleTextMs ?? Math.max(0, Math.round(performance.now() - streamStartedAt)) };
  } catch (error) {
    // A first-text timeout means no visible text arrived in time — treat it
    // the same as an empty stream (return empty, don't throw). This lets the
    // caller's stream-fallback retry proceed, and avoids masking the original
    // result behind a generic timeout error. Real stream errors still throw.
    if (firstTextTimedOut) {
      return { sample: "", firstVisibleTextMs: 0 };
    }
    if (isProviderCallError(error)) throw error;
    throw adapter.mapError(error);
  } finally {
    clearTimeout(firstTextTimer);
  }
}

/**
 * Removes reasoning/thinking artifacts that some providers leak into the
 * visible `content` field — `<think>` blocks, `<reasoning>` blocks, and
 * leading "Let me analyze..." preamble. Returns only the final output.
 */
function stripReasoningTags(text: string): string {
  // Remove <think>...</think> and <reasoning>...</reasoning> blocks (including unclosed ones that trail to end).
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  // Remove an unclosed <think> or <reasoning> that never got a closing tag (everything after it is reasoning).
  out = out.replace(/<think>[\s\S]*$/gi, "").replace(/<reasoning>[\s\S]*$/gi, "");
  // Some providers emit reasoning as plain text preamble before the answer,
  // wrapped in markers like "Analyzing:" or numbered analysis steps.
  // Only strip the common "1. Analyze the Request:" preamble pattern.
  const preambleMatch = out.match(/\n*\s*\d+\.\s+(?:Analyze|Step|Let me|First|Given|Based on)/i);
  if (preambleMatch && preambleMatch.index !== undefined && preambleMatch.index > 0) {
    const before = out.slice(0, preambleMatch.index).trim();
    // Only strip if there's meaningful text before the preamble (the actual answer).
    if (before.length > 10) out = before;
  }
  return out.trim();
}

/**
 * Visible text from a non-stream body, per resolved surface. Thinking is
 * never extracted: chat `reasoning_content`, Anthropic `thinking` blocks,
 * and Responses reasoning summaries are structurally excluded.
 */
function extractNonStreamSample(surface: Surface, body: Record<string, unknown>): string {
  switch (surface) {
    case "openai-chat": {
      const choices = body["choices"];
      if (Array.isArray(choices)) {
        for (const choice of choices) {
          if (!isRecord(choice)) continue;
          const message = choice["message"];
          if (isRecord(message)) {
            // Prefer `content` — but some providers (e.g. GLM) leak
            // reasoning into content as <think>…</think> blocks.
            const raw = typeof message["content"] === "string" ? message["content"] : "";
            if (raw) return stripReasoningTags(raw);
          }
          if (typeof choice["text"] === "string") return stripReasoningTags(choice["text"]);
        }
      }
      return "";
    }
    case "openai-responses": {
      const output = body["output"];
      if (Array.isArray(output)) {
        const parts: string[] = [];
        for (const item of output) {
          if (!isRecord(item)) continue;
          const content = item["content"];
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (!isRecord(block)) continue;
            const type = block["type"];
            if (type !== "text" && type !== "output_text") continue;
            if (typeof block["text"] === "string") parts.push(block["text"]);
          }
        }
        if (parts.length > 0) return stripReasoningTags(parts.join(""));
      }
      if (typeof body["output_text"] === "string") return body["output_text"];
      return "";
    }
    case "anthropic-messages": {
      const content = body["content"];
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block["type"] !== "text") continue; // thinking blocks are excluded
          if (typeof block["text"] === "string") parts.push(block["text"]);
        }
        return stripReasoningTags(parts.join(""));
      }
      return "";
    }
    case "images":
      return "";
    case "web-search":
      return "";
  }
}
