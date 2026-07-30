/** In-process request detail index. Payload files remain under DATA_DIR; runtime metadata is never stored in SQLite. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConsoleEnv } from "../../env";

const details = new Map<number, Record<string, unknown>>();
const detailCreatedAt = new Map<number, number>();
const assets: Array<Record<string, unknown> & { request_id: number; created_at: string; storage_path: string | null }> = [];
const toolCalls: Array<Record<string, unknown> & { request_id: number; created_at: string }> = [];
const MAX_TRACKED_REQUESTS = 5_000;
const REQUEST_DETAIL_TTL_MS = 30 * 60_000;

/** Purges expired detail metadata and enforces the bounded in-process index. */
export function purgeRequestDetailTracking(now = Date.now()): void {
  for (const [requestId, createdAt] of detailCreatedAt) {
    if (now - createdAt <= REQUEST_DETAIL_TTL_MS) continue;
    detailCreatedAt.delete(requestId);
    details.delete(requestId);
  }
  while (details.size > MAX_TRACKED_REQUESTS) {
    const oldest = details.keys().next().value;
    if (oldest === undefined) break;
    details.delete(oldest);
    detailCreatedAt.delete(oldest);
  }
  const cutoff = new Date(now - REQUEST_DETAIL_TTL_MS).toISOString();
  for (let index = assets.length - 1; index >= 0; index--) if (assets[index]!.created_at < cutoff) assets.splice(index, 1);
  for (let index = toolCalls.length - 1; index >= 0; index--) if (toolCalls[index]!.created_at < cutoff) toolCalls.splice(index, 1);
}

export interface RequestDetailInsert {
  requestId: number;
  redactedRequest: string | null;
  redactedResponse: string | null;
  payloadPath: string | null;
  payloadSha256: string | null;
  messageCount: number | null;
  toolNames: string[] | null;
  imageCount: number | null;
}

export function insertRequestDetails(input: RequestDetailInsert): void {
  details.delete(input.requestId);
  details.set(input.requestId, {
    request_id: input.requestId,
    redacted_request: input.redactedRequest,
    redacted_response: input.redactedResponse,
    payload_path: input.payloadPath,
    payload_sha256: input.payloadSha256,
    message_count: input.messageCount,
    tool_names: input.toolNames ? JSON.stringify(input.toolNames) : null,
    image_count: input.imageCount,
  });
  detailCreatedAt.set(input.requestId, Date.now());
  purgeRequestDetailTracking();
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
  assets.push({
    request_id: input.requestId,
    kind: input.kind,
    mime: input.mime,
    bytes: input.bytes,
    sha256: input.sha256,
    storage_path: input.storagePath,
    created_at: new Date().toISOString(),
  });
  while (assets.length > MAX_TRACKED_REQUESTS) assets.shift();
  purgeRequestDetailTracking();
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
  toolCalls.push({
    request_id: input.requestId,
    name: input.name,
    bytes: input.bytes,
    sha256: input.sha256,
    duration_ms: input.durationMs,
    status: input.status,
    created_at: new Date().toISOString(),
  });
  while (toolCalls.length > MAX_TRACKED_REQUESTS) toolCalls.shift();
  purgeRequestDetailTracking();
}

export interface StoredRequestPayload {
  request: unknown;
  response: unknown;
  path: string;
}

/** Load the redacted request/response file whose name is the immutable trace id. */
export function getStoredRequestPayload(traceId: string): StoredRequestPayload | null {
  const path = join(getConsoleEnv().payloadDir, `${traceId}.json`);
  try {
    if (!existsSync(path)) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (!("request" in payload) && !("response" in payload)) return null;
    return { request: payload.request ?? null, response: payload.response ?? null, path };
  } catch {
    return null;
  }
}

export interface RequestDetailBundle {
  detail: Record<string, unknown> | null;
  assets: Record<string, unknown>[];
  toolCalls: Record<string, unknown>[];
}

export function getRequestDetailBundle(requestId: number): RequestDetailBundle {
  return {
    detail: details.get(requestId) ?? null,
    assets: assets.filter((asset) => asset.request_id === requestId),
    toolCalls: toolCalls.filter((toolCall) => toolCall.request_id === requestId),
  };
}

export function purgeAllStoredData(): { details: number; assets: number; toolCalls: number } {
  const count = { details: details.size, assets: assets.length, toolCalls: toolCalls.length };
  details.clear();
  detailCreatedAt.clear();
  assets.length = 0;
  toolCalls.length = 0;
  return count;
}

export function deleteAssetsOlderThan(cutoffDate: string): string[] {
  const paths: string[] = [];
  for (let index = assets.length - 1; index >= 0; index -= 1) {
    const asset = assets[index]!;
    if (asset.created_at >= cutoffDate) continue;
    if (asset.storage_path) paths.push(asset.storage_path);
    assets.splice(index, 1);
  }
  return paths;
}
