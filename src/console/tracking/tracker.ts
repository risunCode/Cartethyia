/**
 * Request tracker — created at the top of each /v1/* handler, finished on
 * success/failure. Persistence is fire-and-forget: tracking failures never
 * break the proxy request (NFR-2).
 */

import { getConsoleEnv } from "../env";
import { getRuntimeSettings } from "../runtime";
import { pushConsoleLog } from "../logs/ring";
import type { ApiKeyPublic } from "../db/repos/api-keys";
import { insertUsageHistory, upsertUsageDaily, appendJsonl, utcNow, utcDateOf } from "../db/repos/usage";
import { insertRequestDetails, insertAssetMeta, insertToolCall } from "../db/repos/details";
import { extractUsage, extractUsageFromSseText, extractToolCalls, type UsageTotals } from "./usage-extractor";
import { computePayloadMeta, extractLastUserMessagePreview } from "./payload-meta";
import { redactPayload } from "./redact";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  meta?: Record<string, unknown>;
}

interface FinishInput {
  status: number;
  provider?: string;
  body?: unknown;
  usage?: UsageTotals;
  errorKind?: string;
  requestBody?: unknown;
}

export interface RequestTracker {
  readonly traceId: string;
  /** Records a completed non-stream request; returns the body for the route to send. */
  finishJson(status: number, body: unknown, provider: string | undefined, requestBody: unknown): unknown;
  /** Wraps an SSE byte stream; usage is captured from the terminal frames. */
  wrapSse(stream: ReadableStream<Uint8Array>, provider: string | undefined, requestBody: unknown): ReadableStream<Uint8Array>;
  /** Records a failed request (no body available). */
  fail(status: number, kind: string, requestBody?: unknown): void;
  /** Sets the proxy pool name used for this request (for logging). */
  setProxyPool(name: string): void;
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

export function createRequestTracker(start: TrackerStartInput): RequestTracker {
  const traceId = crypto.randomUUID();
  const startedMs = Date.now();
  const startedAt = utcNow();
  const provider = providerForModel(start.model);
  let finished = false;
  incrementInFlight();

  let proxyPoolName: string | undefined;

  const persist = (finish: FinishInput): void => {
    if (finished) return;
    finished = true;
    decrementInFlight();
    void persistAsync(start, traceId, startedAt, startedMs, provider, proxyPoolName, finish).catch((err) => {
      pushConsoleLog("error", "tracking", `persist failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    traceId,

    finishJson(status, body, providerOverride, requestBody) {
      persist({ status, provider: providerOverride ?? provider, body, requestBody });
      return body;
    },

    wrapSse(stream, providerOverride, requestBody) {
      const decoder = new TextDecoder();
      let sseText = "";
      const reader = stream.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            const usage = extractUsageFromSseText(start.surface, sseText);
            // Keep the redacted terminal SSE transcript as the completion stage for Request Detail.
            persist({ status: 200, provider: providerOverride ?? provider, usage, body: sseText || undefined, requestBody });
            return;
          }
          sseText += decoder.decode(value, { stream: true });
          if (sseText.length > 200_000) sseText = sseText.slice(-100_000);
          controller.enqueue(value);
        },
        async cancel() {
          await reader.cancel();
          persist({ status: 499, provider: providerOverride ?? provider, errorKind: "aborted", requestBody });
        },
      });
    },

    fail(status, kind, requestBody) {
      persist({ status, errorKind: kind, requestBody });
    },

    setProxyPool(name) {
      proxyPoolName = name;
    },
  };
}

async function persistAsync(
  start: TrackerStartInput,
  traceId: string,
  startedAt: string,
  startedMs: number,
  provider: string | undefined,
  proxyPoolName: string | undefined,
  finish: FinishInput
): Promise<void> {
  const runtime = getRuntimeSettings();
  const env = getConsoleEnv();
  const finishedAt = utcNow();
  const durationMs = Date.now() - startedMs;
  const usage = finish.usage ?? (finish.body !== undefined ? extractUsage(start.surface, finish.body) : null);
  // Computed unconditionally (cheap, no disk write) so the console log tail
  // always shows what was asked and which tools ran, regardless of the
  // heavier TRACK_PAYLOADS storage setting.
  const toolCalls = finish.body !== undefined && finish.status < 400 ? extractToolCalls(start.surface, finish.body) : [];
  const messagePreview = finish.requestBody !== undefined ? extractLastUserMessagePreview(start.surface, finish.requestBody) : undefined;

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

  upsertUsageDaily({
    date: utcDateOf(startedAt),
    apiKeyId: start.apiKey?.id ?? null,
    provider: finish.provider ?? provider ?? null,
    model: start.model ?? null,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.cachedTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    error: finish.status >= 400,
    durationMs,
  });

  const logRecord = {
    traceId,
    endpoint: start.endpoint,
    surface: start.surface,
    provider: finish.provider ?? provider ?? null,
    model: start.model ?? null,
    status: finish.status,
    errorKind: finish.errorKind ?? null,
    stream: start.stream,
    durationMs,
    usage,
    usageSource: usage?.source ?? "missing",
    apiKeyId: start.apiKey?.id ?? null,
    keyPrefix: start.apiKey?.keyPrefix ?? null,
    meta: start.meta ?? {},
    startedAt,
    finishedAt,
  };
  const tracking: Record<string, unknown> = {};

  // Payload details per TRACK_PAYLOADS mode.
  if (runtime.trackPayloads !== "none" && finish.requestBody !== undefined) {
    const meta = computePayloadMeta(start.surface === "responses" ? "responses" : start.surface, finish.requestBody);
    let payloadPath: string | null = null;
    let redactedRequest: string | null = null;
    let redactedResponse: string | null = null;
    if (runtime.trackPayloads === "meta") {
      redactedRequest = null;
      redactedResponse = null;
    } else {
      redactedRequest = redactPayload(finish.requestBody);
      redactedResponse = redactPayload(finish.body);
      mkdirSync(env.payloadDir, { recursive: true });
      payloadPath = join(env.payloadDir, `${traceId}.json`);
      writeFileSync(payloadPath, JSON.stringify({ request: redactedRequest, response: redactedResponse }), "utf8");
    }
    insertRequestDetails({
      requestId: id,
      redactedRequest,
      redactedResponse,
      payloadPath,
      payloadSha256: meta.sha256,
      messageCount: meta.messageCount,
      toolNames: meta.toolNames,
      imageCount: meta.imageCount,
    });
    tracking.payload = {
      mode: runtime.trackPayloads,
      path: payloadPath,
      sha256: meta.sha256,
      messageCount: meta.messageCount,
      toolNames: meta.toolNames,
      imageCount: meta.imageCount,
    };

    if (runtime.trackAssets !== "none" && meta.imageCount > 0) {
      insertAssetMeta({ requestId: id, kind: "image", mime: null, bytes: null, sha256: null, storagePath: null });
      tracking.assets = { mode: runtime.trackAssets, imageCount: meta.imageCount };
    }
  }

  // Tool calls from the response body — already computed above; only
  // persisted to the details DB when TRACK_PAYLOADS allows it.
  if (runtime.trackPayloads !== "none" && toolCalls.length > 0) {
    for (const call of toolCalls) {
      insertToolCall({ requestId: id, name: call.name, bytes: call.bytes, sha256: call.sha256, durationMs: null, status: call.status });
    }
    tracking.toolCalls = toolCalls;
  }

  appendJsonl("requests", { ...logRecord, tracking });
  if (finish.status >= 400) appendJsonl("errors", { ...logRecord, tracking });

  const level = finish.status >= 500 ? "error" : finish.status >= 400 ? "warn" : "info";
  const parts: string[] = [
    `${finish.status < 400 ? "\u2713" : "\u2717"} ${start.endpoint} ${start.model ?? "unknown"} via ${finish.provider ?? provider ?? "unknown"} \u2192 ${finish.status}`,
    `${durationMs}ms`,
  ];
  if (start.stream) parts.push("stream");
  parts.push(proxyPoolName ? `proxy:${proxyPoolName}` : "direct");
  if (usage) {
    const tok: string[] = [];
    if (usage.inputTokens) tok.push(`in:${usage.inputTokens}`);
    if (usage.outputTokens) tok.push(`out:${usage.outputTokens}`);
    if (usage.cachedTokens) tok.push(`cached:${usage.cachedTokens}`);
    if (usage.reasoningTokens) tok.push(`reason:${usage.reasoningTokens}`);
    if (tok.length > 0) parts.push(tok.join(" "));
  }
  if (toolCalls.length > 0) parts.push(`tools:${toolCalls.map((c) => c.name).join(",")}`);
  if (messagePreview) parts.push(`msg:"${messagePreview}"`);
  pushConsoleLog(level, "request", parts.join(" \u00b7 "));
}
