import type { RequestTelemetryHandle, TelemetryFinish, TelemetryWriter } from "../../application/contracts";
import { formatUtc, mapClientName, mapClientSource } from "./runtime";
import type { SqlValue, WriteBuffer } from "./write-buffer";

const INSERT_SQL = `INSERT INTO request_history (
  trace_id, endpoint, surface, api_key_id, api_key_prefix, provider, model, status, error_kind, stream,
  started_at, finished_at, duration_ms, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens, usage_source, meta_json, client_name, client_source, message_count, tool_count, image_count, tfft_ms, client_ip
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_SQL = `${INSERT_SQL} ON CONFLICT(trace_id) DO UPDATE SET
  endpoint = excluded.endpoint, surface = excluded.surface, provider = excluded.provider, model = excluded.model,
  status = excluded.status, error_kind = excluded.error_kind, stream = excluded.stream,
  finished_at = excluded.finished_at, duration_ms = excluded.duration_ms,
  input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
  cached_tokens = excluded.cached_tokens, cache_write_tokens = excluded.cache_write_tokens,
  reasoning_tokens = excluded.reasoning_tokens, total_tokens = excluded.total_tokens,
  usage_source = excluded.usage_source, meta_json = excluded.meta_json, client_name = excluded.client_name, client_source = excluded.client_source,
  message_count = excluded.message_count, tool_count = excluded.tool_count, image_count = excluded.image_count,
  tfft_ms = excluded.tfft_ms, client_ip = excluded.client_ip`;

function parseUtc(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
export function createRuntimeTelemetryWriter(buffer: WriteBuffer, isTraceIdUnique: () => boolean, _invalidateQueryCaches: () => void): TelemetryWriter { return {
  start(input: Parameters<TelemetryWriter["start"]>[0]): RequestTelemetryHandle {
    const requestId = input.requestId;
    const clientName = mapClientName(input.clientName);
    const clientSource = mapClientSource(input.clientSource);
    const startedMs = parseUtc(input.startedAt) ?? Date.now();
    const startedAt = formatUtc(startedMs);
    let finished = false;
    let tfftMs: number | null = null;

    const recordFirstToken = (): void => {
      if (tfftMs === null) tfftMs = Math.max(0, Date.now() - startedMs);
    };

    const finish = async (result: TelemetryFinish): Promise<void> => {
      if (finished) return;
      finished = true;
      const endedMs = Date.now();
      const finishedAt = formatUtc(endedMs);
      const usage = result.usage;
      const params: SqlValue[] = [
        requestId,
        input.endpoint,
        input.surface,
        input.apiKeyId,
        input.apiKeyPrefix,
        result.providerId,
        result.model,
        result.statusCode,
        result.errorKind,
        result.mode === "stream" ? 1 : 0,
        startedAt,
        finishedAt,
        Math.max(0, endedMs - startedMs),
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.cacheWriteTokens ?? null,
        usage?.reasoningTokens ?? null,
        usage?.totalTokens ?? null,
        usage?.source ?? "unknown",
        JSON.stringify(result.routing ?? {}),
        clientName,
        clientSource,
        result.messageCount,
        result.toolCount,
        result.imageCount,
        tfftMs,
        input.clientIp ?? null,
      ];
      buffer.enqueue(isTraceIdUnique() ? UPSERT_SQL : INSERT_SQL, params);
    };

    return {
      requestId,
      recordSwitch() {},
      recordFirstToken,
      finish,
    };
  },
}; }
