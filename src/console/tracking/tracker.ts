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
import { computePayloadMeta, extractLastUserMessagePreview } from "./payload-meta";
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

/**
 * Single glyph-first console log line, shared by every request source (proxy
 * `/v1/*` traffic, Model Studio, and the console's provider Test Connection
 * probe) so a request looks the same regardless of where it came from.
 */
export function formatRequestLogLine(args: {
  model: string | undefined;
  provider: string | undefined;
  accountLabel?: string;
  status: number;
  durationMs: number;
  stream?: boolean;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; cachedTokens?: number | null; reasoningTokens?: number | null };
  toolNames?: string[];
  messagePreview?: string;
  errorMessage?: string;
}): string {
  const label = args.model ?? args.provider ?? "unknown";
  const glyph = args.status < 400 ? "\u2705" : "\u274c";

  if (args.status >= 400) {
    return `${glyph} ${label} [${args.status}]${args.errorMessage ? `: ${args.errorMessage}` : ""}`;
  }

  const parts: string[] = [`${glyph} ${label}${args.provider ? ` via ${args.provider}` : ""} \u2192 ${args.status}`, `${args.durationMs}ms`];
  if (args.accountLabel) parts.push(`ACC:${args.accountLabel}`);
  if (args.stream) parts.push("stream");
  if (args.usage) {
    const tok: string[] = [];
    if (args.usage.inputTokens) tok.push(`in:${args.usage.inputTokens}`);
    if (args.usage.outputTokens) tok.push(`out:${args.usage.outputTokens}`);
    if (args.usage.cachedTokens) tok.push(`cached:${args.usage.cachedTokens}`);
    if (args.usage.reasoningTokens) tok.push(`reason:${args.usage.reasoningTokens}`);
    if (tok.length > 0) parts.push(tok.join(" "));
  }
  if (args.toolNames && args.toolNames.length > 0) parts.push(`tools:${args.toolNames.join(",")}`);
  if (args.messagePreview) parts.push(`msg:"${args.messagePreview}"`);
  return parts.join(" \u00b7 ");
}

export function createRequestTracker(start: TrackerStartInput): RequestTracker {
  const traceId = crypto.randomUUID();
  const startedMs = Date.now();
  const startedAt = utcNow();
  const provider = providerForModel(start.model);
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
    void persistAsync(start, traceId, startedAt, startedMs, provider, finish, settleTokenUsage).catch((err) => {
      settleTokenUsage(0);
      pushConsoleLog("error", "tracking", `persist failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    traceId,

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
      stream: start.stream,
      usage: usage ?? undefined,
      toolNames: toolCalls.map((c) => c.name),
      messagePreview,
      errorMessage: finish.errorMessage,
    })
  );
}
