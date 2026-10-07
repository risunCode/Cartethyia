import type { CartethyiaDatabase } from "../persistence/db-handle";
import { DrizzleTelemetryStore } from "../persistence/stores/telemetry-store";
import { prunePayloadFrames, writePayloadFrame } from "./payload-store";
import { resolveTelemetryPayloadMaxBytes } from "../config/telemetry";
export type CaptureScope = "tenant" | "debug_session" | "operator_flag";

export interface PayloadCaptureInput {
  tenantId: string;
  requestBody: unknown;
  responseBody: unknown;
  clientResponseBody?: unknown;
  providerRequestBody?: unknown;
  providerResponseBody?: unknown;
  /**
   * Combined body cap override for this capture (Settings → capture depth).
   * Defaults to the configured capture limit.
   */
  maxBytes?: number;
  scope: CaptureScope;
  /** Links the row to `telemetry_events.request_id`. */
  requestId?: string;
  // optional opt-in flags — exactly one must be true for `scope`, see `isCaptureAllowed`
  tenantOptIn?: boolean;
  debugSessionOptIn?: boolean;
  operatorFlagOptIn?: boolean;
}

export interface PayloadSignals {
  readonly toolCalls: number;
  readonly images: number;
  readonly attachments: number;
}

export interface StoredPayload {
  id: string;
  /**
   * JSON text of the five body surfaces, in drawer order, built while the
   * record was measured. Present only on a record that has not been persisted
   * yet; the frame writer consumes it so the bodies are not serialized twice.
   */
  _serialized?: readonly string[];
  request_id: string | null;
  captured_at: Date;
  expires_at: Date;
  request_body: unknown;
  response_body: unknown;
  client_response_body: unknown;
  provider_request_body: unknown;
  provider_response_body: unknown;
  signals: PayloadSignals;
}

function payloadRetentionMs(): number {
  const raw = Number(process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS ?? 15 * 60_000);
  if (!Number.isFinite(raw) || raw < 1_000 || raw > 7 * 24 * 60 * 60_000) return 15 * 60_000;
  return Math.floor(raw);
}
function isCaptureAllowed(input: PayloadCaptureInput): boolean {
  // Exactly one opt-in must be set, and it must be the one `scope` names:
  // two flags at once would silently widen capture beyond the declared scope.
  const optIns = [input.tenantOptIn, input.debugSessionOptIn, input.operatorFlagOptIn];
  if (optIns.filter(Boolean).length !== 1) return false;
  if (input.scope === "tenant") return input.tenantOptIn === true;
  if (input.scope === "debug_session") return input.debugSessionOptIn === true;
  if (input.scope === "operator_flag") return input.operatorFlagOptIn === true;
  return false;
}

function payloadSignals(values: readonly unknown[]): PayloadSignals {
  let toolCalls = 0;
  let images = 0;
  let attachments = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record["type"] === "string" ? record["type"].toLowerCase() : "";
    if (type === "tool_call" || type === "tool_use" || type === "function_call") toolCalls += 1;
    if (type === "image" || type === "input_image" || type === "output_image") images += 1;
    if (type === "file" || type === "document" || type === "attachment") attachments += 1;
    for (const [key, child] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "tool_calls" || normalizedKey === "toolcalls") {
        if (Array.isArray(child)) toolCalls += child.length;
      } else if (normalizedKey === "attachments" || normalizedKey === "files") {
        if (Array.isArray(child)) attachments += child.length;
      } else if (
        (normalizedKey === "image_url" ||
          normalizedKey === "input_image" ||
          normalizedKey === "output_image") &&
        !type.includes("image")
      ) {
        images += 1;
      }
      visit(child, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return { toolCalls, images, attachments };
}

/**
 * Shapes a captured payload without persisting it — a pure helper reused by
 * `TelemetryPayloadCapture.capture` and exercised directly in tests. Bodies
 * larger than `maxBytes` (combined, post-redaction, defaulting to the
 * configured capture limit) are dropped and replaced with a truncation
 * marker — no object store exists, so an oversized body is never referenced,
 * only accounted. Payloads remain redacted and bounded during the 15-minute
 * retention window.
 */
export function buildPayloadRecord(
  input: PayloadCaptureInput,
  now = new Date(),
  maxBytes = resolveTelemetryPayloadMaxBytes(),
): Omit<StoredPayload, "id"> {
  const expiresAt = new Date(now.getTime() + payloadRetentionMs());
  // Each body is serialized once, in drawer order, and only while the running
  // total still fits the cap. The old path serialized every body up front to
  // measure them and then serialized the whole record again to store it, so a
  // capture held two copies of every body at once — measured at 23 MB of heap
  // for 8 MB of bodies. A body that would cross the cap is never touched: its
  // text is not built and its object is not walked for signals.
  const surfaces: ReadonlyArray<readonly [keyof StoredPayload, unknown]> = [
    ["request_body", input.requestBody],
    ["response_body", input.responseBody],
    ["client_response_body", input.clientResponseBody],
    ["provider_request_body", input.providerRequestBody],
    ["provider_response_body", input.providerResponseBody],
  ];
  const stored: Partial<Record<keyof StoredPayload, unknown>> = {};
  const serialized: string[] = [];
  const kept: unknown[] = [];
  let accounted = 0;
  let truncated = false;
  for (const [key, body] of surfaces) {
    if (truncated || body === undefined || body === null) {
      stored[key] = null;
      serialized.push("null");
      continue;
    }
    const text = JSON.stringify(body);
    if (accounted + text.length > maxBytes) {
      truncated = true;
      stored[key] = null;
      serialized.push("null");
      continue;
    }
    accounted += text.length;
    stored[key] = body;
    serialized.push(text);
    kept.push(body);
  }
  const marker = truncated
    ? {
        _truncated: true,
        _original_bytes: accounted,
        _hint: "Truncated by the capture cap — raise Settings → Telemetry payloads → Capture depth to keep more.",
      }
    : undefined;
  if (marker) {
    for (const [key] of surfaces) {
      if (stored[key] === null) stored[key] = marker;
    }
  }
  return {
    request_id: input.requestId ?? null,
    captured_at: now,
    expires_at: expiresAt,
    request_body: stored.request_body ?? null,
    response_body: stored.response_body ?? null,
    client_response_body: stored.client_response_body ?? null,
    provider_request_body: stored.provider_request_body ?? null,
    provider_response_body: stored.provider_response_body ?? null,
    signals: payloadSignals(kept),
    _serialized: serialized,
  };
}

/**
 * Postgres-backed redacted request/response payload capture. Payloads have a
 * 15-minute retention window and are automatically pruned.

 */
export class TelemetryPayloadCapture {
  private readonly store: DrizzleTelemetryStore;

  constructor(db: CartethyiaDatabase) {
    this.store = new DrizzleTelemetryStore(db);
  }

  async capture(input: PayloadCaptureInput): Promise<{ id: string; expiresAt: Date }> {
    if (!isCaptureAllowed(input)) {
      throw Object.assign(new Error("payload capture not opted in"), {
        code: "capture_not_opted_in",
      });
    }
    const record = buildPayloadRecord(input, new Date(), input.maxBytes ?? resolveTelemetryPayloadMaxBytes());
    const reference = await writePayloadFrame(record, record.expires_at, record._serialized
      ? {
          requestId: record.request_id,
          capturedAt: record.captured_at.toISOString(),
          signals: record.signals,
          bodies: record._serialized,
        }
      : undefined);
    // Typed columns only — bodies live in the frame file. The schema has no
    // jsonb body column, so a body cannot be written to Postgres here.
    return this.store.insertPayload({
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      capturedAt: record.captured_at,
      expiresAt: record.expires_at,
      storage: reference.storage,
      file: reference.file,
      offset: reference.offset,
      length: reference.length,
      checksum: reference.checksum,
      version: reference.version,
    });
  }

  async cleanupExpired(batchSize = 5000, now = new Date()): Promise<{ deleted: number }> {
    let deleted = 0;
    for (let run = 0; run < 40; run += 1) {
      const batch = await this.store.deleteExpiredPayloads(batchSize, now);
      deleted += batch;
      if (batch < batchSize) break;
    }
    // Every frame expires `payloadRetentionMs()` after it is written, so a file
    // last written before that window closed cannot still hold a live frame.
    // That bound is what makes a damaged, unparsable file reclaimable at all.
    deleted += await prunePayloadFrames(now, new Date(now.getTime() - payloadRetentionMs()));
    return { deleted };
  }
}
