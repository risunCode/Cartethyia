/**
 * Per-request detail index - request_details/request_assets/request_tool_calls
 * in `runtime.sqlite` (see `../runtime-client.ts`). Durable across restarts;
 * retention is date-cutoff based (see `deleteRequestDetailsOlderThan` and
 * friends, called from `tracking/rotate.ts`), matching request_history and
 * console_logs instead of an in-process TTL/cap.
 */

import { getRuntimeDb } from "../runtime-client";

export interface RequestDetailInsert {
  requestId: number;
  redactedRequest: string | null;
  redactedResponse: string | null;
  payloadMode: string | null;
  payloadSha256: string | null;
  messageCount: number | null;
  toolNames: string[] | null;
  imageCount: number | null;
}

export function insertRequestDetails(input: RequestDetailInsert): void {
  getRuntimeDb()
    .query(
      `INSERT INTO request_details (
        request_id, redacted_request, redacted_response, payload_mode, payload_sha256,
        message_count, tool_names, image_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        redacted_request = excluded.redacted_request,
        redacted_response = excluded.redacted_response,
        payload_mode = excluded.payload_mode,
        payload_sha256 = excluded.payload_sha256,
        message_count = excluded.message_count,
        tool_names = excluded.tool_names,
        image_count = excluded.image_count,
        created_at = excluded.created_at`,
    )
    .run(
      input.requestId, input.redactedRequest, input.redactedResponse, input.payloadMode, input.payloadSha256,
      input.messageCount, input.toolNames ? JSON.stringify(input.toolNames) : null, input.imageCount, new Date().toISOString(),
    );
}

export interface AssetMetaInsert {
  requestId: number;
  kind: string;
  mime: string | null;
  bytes: number | null;
  sha256: string | null;
  storagePath: string | null;
}

export function insertAssetMeta(input: AssetMetaInsert): void {
  getRuntimeDb()
    .query("INSERT INTO request_assets (request_id, kind, mime, bytes, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(input.requestId, input.kind, input.mime, input.bytes, input.sha256, input.storagePath, new Date().toISOString());
}

export interface ToolCallInsert {
  requestId: number;
  name: string;
  bytes: number | null;
  sha256: string | null;
  durationMs: number | null;
  status: string | null;
}

export function insertToolCall(input: ToolCallInsert): void {
  getRuntimeDb()
    .query("INSERT INTO request_tool_calls (request_id, name, bytes, sha256, duration_ms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(input.requestId, input.name, input.bytes, input.sha256, input.durationMs, input.status, new Date().toISOString());
}

export interface RequestDetailBundle {
  detail: Record<string, unknown> | null;
  assets: Record<string, unknown>[];
  toolCalls: Record<string, unknown>[];
}

export function getRequestDetailBundle(requestId: number): RequestDetailBundle {
  const db = getRuntimeDb();
  const detail = db.query("SELECT * FROM request_details WHERE request_id = ?").get(requestId) as Record<string, unknown> | null;
  const assets = db.query("SELECT * FROM request_assets WHERE request_id = ? ORDER BY id ASC").all(requestId) as Record<string, unknown>[];
  const toolCalls = db.query("SELECT * FROM request_tool_calls WHERE request_id = ? ORDER BY id ASC").all(requestId) as Record<string, unknown>[];
  return { detail, assets, toolCalls };
}

export function purgeAllStoredData(): { details: number; assets: number; toolCalls: number } {
  const db = getRuntimeDb();
  const details = db.query("SELECT COUNT(*) AS n FROM request_details").get() as { n: number };
  const assets = db.query("SELECT COUNT(*) AS n FROM request_assets").get() as { n: number };
  const toolCalls = db.query("SELECT COUNT(*) AS n FROM request_tool_calls").get() as { n: number };
  db.exec("DELETE FROM request_details");
  db.exec("DELETE FROM request_assets");
  db.exec("DELETE FROM request_tool_calls");
  return { details: details.n, assets: assets.n, toolCalls: toolCalls.n };
}

/** Deletes request_details rows older than a "YYYY-MM-DD" cutoff (retention). Returns the row count removed. */
export function deleteRequestDetailsOlderThan(cutoffDate: string): number {
  return getRuntimeDb().query("DELETE FROM request_details WHERE created_at < ?").run(cutoffDate).changes;
}

/**
 * Deletes request_assets rows older than a "YYYY-MM-DD" cutoff and returns
 * the storage paths of any deleted rows that had one, so the caller can also
 * remove the backing file (none are currently written - `insertAssetMeta` is
 * always called with `storagePath: null` until asset storage is implemented -
 * but the contract stays file-cleanup-ready).
 */
export function deleteRequestAssetsOlderThan(cutoffDate: string): string[] {
  const db = getRuntimeDb();
  const rows = db.query("SELECT storage_path FROM request_assets WHERE created_at < ? AND storage_path IS NOT NULL").all(cutoffDate) as { storage_path: string }[];
  db.query("DELETE FROM request_assets WHERE created_at < ?").run(cutoffDate);
  return rows.map((row) => row.storage_path);
}

/** Deletes request_tool_calls rows older than a "YYYY-MM-DD" cutoff (retention). Returns the row count removed. */
export function deleteRequestToolCallsOlderThan(cutoffDate: string): number {
  return getRuntimeDb().query("DELETE FROM request_tool_calls WHERE created_at < ?").run(cutoffDate).changes;
}
