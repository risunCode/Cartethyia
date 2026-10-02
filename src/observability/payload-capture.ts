import { redactTelemetryValue } from "./redaction";
import type { CartethyiaDatabase } from "../persistence/postgres";
import { DrizzleTelemetryStore } from "../persistence/telemetry-store";
import { prunePayloadFrames, writePayloadFrame } from "./payload-store";
import { resolveTelemetryPayloadMaxBytes } from "../config";
export type CaptureScope = "tenant" | "debug_session" | "operator_flag";

export interface PayloadCaptureInput {
  tenantId: string;
  requestBody: unknown;
  responseBody: unknown;
  clientResponseBody?: unknown;
  providerRequestBody?: unknown;
  providerResponseBody?: unknown;
  scope: CaptureScope;
  /** Links the row to `telemetry_events.request_id`. */
  requestId?: string;
  // optional opt-in flags — exactly one must be true for `scope`, see `isCaptureAllowed`
  tenantOptIn?: boolean;
  debugSessionOptIn?: boolean;
  operatorFlagOptIn?: boolean;
}

export interface StoredPayload {
  id: string;
  request_id: string | null;
  captured_at: Date;
  expires_at: Date;
  request_body: unknown;
  response_body: unknown;
  client_response_body: unknown;
  provider_request_body: unknown;
  provider_response_body: unknown;
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

/**
 * Shapes a captured payload without persisting it — a pure helper reused by
 * `TelemetryPayloadCapture.capture` and exercised directly in tests. Bodies
 * larger than 1MB (combined, post-redaction) are dropped and replaced with a
 * truncation marker — no object store exists, so an oversized body is never
 * referenced, only accounted. Payloads remain redacted and bounded during the
 * 15-minute retention window.
 */
export function buildPayloadRecord(
  input: PayloadCaptureInput,
  now = new Date(),
): Omit<StoredPayload, "id"> {
  const expiresAt = new Date(now.getTime() + payloadRetentionMs());
  const requestBody = redactTelemetryValue(input.requestBody);
  const responseBody = redactTelemetryValue(input.responseBody);
  const clientResponseBody =
    input.clientResponseBody === undefined ? undefined : redactTelemetryValue(input.clientResponseBody);
  const providerRequestBody =
    input.providerRequestBody === undefined ? undefined : redactTelemetryValue(input.providerRequestBody);
  const providerResponseBody =
    input.providerResponseBody === undefined ? undefined : redactTelemetryValue(input.providerResponseBody);
  // Serialize each body exactly once: the text is both measured and stored,
  // so the hot path pays one JSON.stringify per body instead of five.
  const bodies = [requestBody, responseBody, clientResponseBody, providerRequestBody, providerResponseBody];
  const serialized = bodies.map((body) => JSON.stringify(body ?? null));
  const approxSize = serialized.reduce((total, text) => total + text.length, 0);
  let storedRequestBody: unknown = requestBody;
  let storedResponseBody: unknown = responseBody;
  let storedClientResponseBody: unknown = clientResponseBody;
  let storedProviderRequestBody: unknown = providerRequestBody;
  let storedProviderResponseBody: unknown = providerResponseBody;
  if (approxSize > resolveTelemetryPayloadMaxBytes()) {
    const truncated = (): { _truncated: true; _original_bytes: number } => ({
      _truncated: true,
      _original_bytes: approxSize,
    });
    storedRequestBody = truncated();
    storedResponseBody = truncated();
    storedClientResponseBody = truncated();
    storedProviderRequestBody = truncated();
    storedProviderResponseBody = truncated();
  }
  return {
    request_id: input.requestId ?? null,
    captured_at: now,
    expires_at: expiresAt,
    request_body: storedRequestBody,
    response_body: storedResponseBody,
    client_response_body: storedClientResponseBody,
    provider_request_body: storedProviderRequestBody,
    provider_response_body: storedProviderResponseBody,
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
    const record = buildPayloadRecord(input);
    const reference = await writePayloadFrame(record, record.expires_at);
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
