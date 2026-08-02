/**
 * Request tracker — created at the top of each /v1/* handler, finished on
 * success/failure. Persistence is fire-and-forget: tracking failures never
 * break the proxy request (NFR-2).
 */

import { getRuntimeSettings } from "../runtime";
import { pushConsoleLog } from "../logs/ring";
import type { ApiKeyPublic } from "../db/repos/api-keys";
import { insertUsageHistory, utcNow } from "../db/repos/usage";
import { insertRequestDetails, insertAssetMeta, insertToolCall } from "../db/repos/details";
import { extractUsage, extractUsageFromSseText, extractToolCalls, type UsageTotals } from "./usage-extractor";
import { computePayloadMeta, countPayloadMessages } from "./payload-meta";
import { parseQualifiedModel } from "../../routing/resolve";
import { incrementInFlight, decrementInFlight } from "./in-flight";

export type TrackSurface = "chat" | "anthropic" | "responses";

export interface TrackerStartInput {
  endpoint: string;
  surface: TrackSurface;
  model: string | undefined;
  stream: boolean;
  request: Request;
  apiKey: ApiKeyPublic | null;
  onTokenUsage?: (tokens: number) => void;
  meta?: Record<string, unknown>;
}

interface FinishInput {
  status: number;
  provider?: string;
  body?: unknown;
  usage?: UsageTotals;
  errorKind?: string;
  errorMessage?: string;
  requestBody?: unknown;
  accountLabel?: string;
}

export interface RequestTracker {
  readonly traceId: string;
  setNetworkPath: (networkPath: string) => void;
  /** Records a completed non-stream request; returns the body for the route to send. */
  finishJson(status: number, body: unknown, provider: string | undefined, requestBody: unknown, accountLabel?: string): unknown;
  /** Wraps an SSE byte stream; usage is captured from the terminal frames. */
  wrapSse(stream: ReadableStream<Uint8Array>, provider: string | undefined, requestBody: unknown, accountLabel?: string): ReadableStream<Uint8Array>;
  /** Records a failed request (no body available). */
  fail(status: number, kind: string, requestBody?: unknown, errorMessage?: string): void;
}

/** Best-effort provider label for a bare (unqualified) model name that never resolves through the registry — log/usage display only, never used to route or dispatch a request. */
function guessProviderLabel(model: string): "openai" | "anthropic" {
  return model.startsWith("claude") ? "anthropic" : "openai";
}

export function providerForModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const parsed = parseQualifiedModel(model);
  if (parsed.kind === "qualified") return parsed.model.provider;
  return guessProviderLabel(model);
}

export type RequestLogEvent = "incoming" | "request_success" | "request_failed";

/** One canonical console-log formatter for inbound, successful, and failed requests. */
export function formatRequestLogLine(args: {
  eventName?: RequestLogEvent;
  model?: string;
  provider?: string;
  accountLabel?: string;
  networkPath?: string;
  status?: number;
  durationMs?: number;
  usage?: { inputTokens?: number | null; outputTokens?: number | null };
  messageCount?: number;
  toolCount?: number;
  errorMessage?: string;
}): string {
  const eventName = args.eventName ?? (args.status !== undefined && args.status >= 400 ? "request_failed" : "request_success");
  const parts: string[] = [eventName];
  if (args.provider) parts.push(`provider=${args.provider}`);
  if (args.accountLabel) parts.push(`account=${args.accountLabel}`);
  if (args.networkPath) parts.push(`proxy=${args.networkPath}`);
  if (args.model) parts.push(`model=${args.model}`);
  if (args.status !== undefined) parts.push(`status=${args.status}`);
  if (args.durationMs !== undefined) parts.push(`${args.durationMs}ms`);
  if (args.usage?.inputTokens !== null && args.usage?.inputTokens !== undefined) parts.push(`in ${args.usage.inputTokens} tokens`);
  if (args.usage?.outputTokens !== null && args.usage?.outputTokens !== undefined) parts.push(`out ${args.usage.outputTokens} tokens`);
  if (args.messageCount !== undefined) parts.push(`${args.messageCount}msg`);
  if (args.toolCount !== undefined) parts.push(`${args.toolCount} tools`);
  if (args.errorMessage) parts.push(`error=${args.errorMessage}`);
  return parts.join(" | ");
}

export function createRequestTracker(start: TrackerStartInput): RequestTracker {
  const traceId = crypto.randomUUID();
  const startedMs = Date.now();
  const startedAt = utcNow();
  const provider = providerForModel(start.model);
  let networkPath: string | undefined;
  let finished = false;
  let tokenUsageSettled = false;
  incrementInFlight();

  const settleTokenUsage = (tokens: number): void => {
    if (tokenUsageSettled) return;
    tokenUsageSettled = true;
    start.onTokenUsage?.(tokens);
  };

  const persist = (finish: FinishInput): void => {
    if (finished) return;
    finished = true;
    decrementInFlight();
    void persistAsync(start, traceId, startedAt, startedMs, provider, finish, settleTokenUsage, networkPath).catch((err) => {
      settleTokenUsage(0);
      pushConsoleLog("error", "tracking", `persist failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    traceId,
    setNetworkPath: (value) => { networkPath = value; },

    finishJson(status, body, providerOverride, requestBody, accountLabel) {
      persist({ status, provider: providerOverride ?? provider, body, requestBody, accountLabel });
      return body;
    },

    wrapSse(stream, providerOverride, requestBody, accountLabel) {
      const decoder = new TextDecoder();
      let sseText = "";
      const reader = stream.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            const usage = extractUsageFromSseText(start.surface, sseText);
            // The response transcript is retained only in memory long enough to
            // recover terminal usage; no request or response body is persisted.
            persist({ status: 200, provider: providerOverride ?? provider, usage, requestBody, accountLabel });
            return;
          }
          sseText += decoder.decode(value, { stream: true });
          if (sseText.length > 200_000) sseText = sseText.slice(-100_000);
          controller.enqueue(value);
        },
        async cancel() {
          await reader.cancel();
          persist({ status: 499, provider: providerOverride ?? provider, errorKind: "aborted", requestBody, accountLabel });
        },
      });
    },

    fail(status, kind, requestBody, errorMessage) {
      persist({ status, errorKind: kind, requestBody, errorMessage });
    },
  };
}

async function persistAsync(
  start: TrackerStartInput,
  traceId: string,
  startedAt: string,
  startedMs: number,
  provider: string | undefined,
  finish: FinishInput,
  settleTokenUsage: (tokens: number) => void,
  networkPath: string | undefined,
): Promise<void> {
  const runtime = getRuntimeSettings();
  const finishedAt = utcNow();
  const durationMs = Date.now() - startedMs;
  const usage = finish.usage ?? (finish.body !== undefined ? extractUsage(start.surface, finish.body) : null);
  settleTokenUsage((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
  // Computed unconditionally (cheap, no disk write) so the console log tail
  // always shows what was asked and which tools ran, regardless of the
  // TRACK_PAYLOADS setting.
  const toolCalls = finish.body !== undefined && finish.status < 400 ? extractToolCalls(start.surface, finish.body) : [];
  const id = insertUsageHistory({
    traceId,
    endpoint: start.endpoint,
    surface: start.surface,
    apiKeyId: start.apiKey?.id ?? null,
    apiKeyPrefix: start.apiKey?.keyPrefix ?? null,
    provider: finish.provider ?? provider ?? null,
    model: start.model ?? null,
    status: finish.status,
    errorKind: finish.errorKind ?? null,
    stream: start.stream,
    startedAt,
    finishedAt,
    durationMs,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedTokens: usage?.cachedTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    usageSource: usage?.source ?? "missing",
    meta: start.meta ?? {},
  });

  // Payload/tool-call metadata per TRACK_PAYLOADS mode - persisted once,
  // directly into request_details/request_tool_calls (runtime.sqlite).
  // request_history (inserted above) already carries every other field a
  // separate JSONL archival record used to duplicate.
  if (runtime.trackPayloads !== "none" && finish.requestBody !== undefined) {
    const meta = computePayloadMeta(start.surface === "responses" ? "responses" : start.surface, finish.requestBody);
    insertRequestDetails({
      requestId: id,
      redactedRequest: null,
      redactedResponse: null,
      payloadMode: "meta",
      payloadSha256: meta.sha256,
      messageCount: meta.messageCount,
      toolNames: meta.toolNames,
      imageCount: meta.imageCount,
    });

    if (runtime.trackAssets !== "none" && meta.imageCount > 0) {
      insertAssetMeta({ requestId: id, kind: "image", mime: null, bytes: null, sha256: null, storagePath: null });
    }
  }

  // Tool calls from the response body — already computed above; only
  // persisted to the details DB when TRACK_PAYLOADS allows it.
  if (runtime.trackPayloads !== "none" && toolCalls.length > 0) {
    for (const call of toolCalls) {
      insertToolCall({ requestId: id, name: call.name, bytes: call.bytes, sha256: call.sha256, durationMs: null, status: call.status });
    }
  }

  const level = finish.status >= 500 ? "error" : finish.status >= 400 ? "warn" : "info";
  pushConsoleLog(
    level,
    "request",
    formatRequestLogLine({
      model: start.model,
      provider: finish.provider ?? provider,
      accountLabel: finish.accountLabel,
      status: finish.status,
      durationMs,
      usage: usage ?? undefined,
      messageCount: finish.requestBody === undefined ? undefined : countPayloadMessages(start.surface, finish.requestBody as Record<string, unknown>),
      toolCount: toolCalls.length,
      errorMessage: finish.errorMessage,
      networkPath,
    })
  );
}
