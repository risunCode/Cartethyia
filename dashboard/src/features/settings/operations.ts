import { ApiError, apiRaw } from "../../lib/api";
import { ConsoleContractError } from "../../lib/console-api";

export const MAX_BACKUP_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export interface RuntimeSettings {
  readonly environment: string;
  readonly logLevel: string;
  readonly listenAddr: string;
  readonly flags: Readonly<Record<string, boolean>>;
}

export interface BackupRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly includesDatabase: boolean;
}

export interface RestoreResult {
  readonly applied: boolean;
  readonly changed: readonly string[];
  readonly notes: string | null;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly detail: string | null;
}

/** Parses bounded tool operation results and discards arbitrary daemon metadata. */
export function parseToolResult(value: unknown): ToolResult {
  if (!isRecord(value)) throw new ConsoleContractError("invalid_contract", "tool result is invalid", 502);
  return {
    ok: value.ok === true,
    detail: boundedString(value.detail, "No operator detail supplied"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, fallback: string, max = 160): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 && normalized.length <= max ? normalized : fallback;
}

/** Parses the daemon runtime settings while discarding arbitrary metadata. */
export function parseRuntimeSettings(value: unknown): RuntimeSettings {
  if (!isRecord(value)) throw new ConsoleContractError("invalid_contract", "runtime settings are invalid", 502);
  const flags: Record<string, boolean> = {};
  if (isRecord(value.flags)) {
    for (const [key, flag] of Object.entries(value.flags)) {
      if (/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) && typeof flag === "boolean") flags[key] = flag;
    }
  }
  return {
    environment: boundedString(value.environment, "unknown"),
    logLevel: boundedString(value.logLevel, "unknown"),
    listenAddr: boundedString(value.listenAddr, "unknown"),
    flags,
  };
}

/** Parses a bounded backup list and rejects malformed daemon contracts. */
export function parseBackupList(value: unknown): readonly BackupRecord[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new ConsoleContractError("invalid_contract", "backup list is invalid", 502);
  return value.items.flatMap((item): BackupRecord[] => {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0 || typeof item.createdAt !== "string") return [];
    const sizeBytes = typeof item.sizeBytes === "number" && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 ? item.sizeBytes : null;
    if (sizeBytes === null) return [];
    return [{ id: item.id, createdAt: item.createdAt, sizeBytes, includesDatabase: item.includesDatabase === true }];
  });
}

/** Parses a restore result without retaining arbitrary daemon metadata. */
export function parseRestoreResult(value: unknown): RestoreResult {
  if (!isRecord(value) || typeof value.applied !== "boolean") throw new ConsoleContractError("invalid_contract", "restore result is invalid", 502);
  const changed = Array.isArray(value.changed)
    ? value.changed.filter((item): item is string => typeof item === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(item)).slice(0, 100)
    : [];
  return { applied: value.applied, changed, notes: null };
}

/** Rejects probe URLs that would put credential material in browser state or requests. */
export function validateProbeUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) throw new Error("probe URL is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("probe URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("probe URL must use HTTP or HTTPS");
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => /token|secret|password|credential|authorization|cookie|api[-_]?key/i.test(key))) {
    throw new Error("probe URL must not contain credentials");
  }
  return url.toString();
}

/** Produces a safe bounded download filename from an untrusted response header. */
export function safeBackupFilename(value: string | null): string {
  const source = value?.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop()?.trim() ?? "";
  const normalized = source.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 96);
  if (normalized.length === 0 || normalized === "." || normalized === "..") return "cartethyia-backup.bin";
  return normalized.includes(".") ? normalized : `${normalized}.bin`;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Blob> {
  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > maxBytes) throw new ApiError(413, "response_too_large", "backup download exceeds the safe size limit");
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) throw new ApiError(413, "response_too_large", "backup download exceeds the safe size limit");
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "response_too_large", "backup download exceeds the safe size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parts = chunks.map((chunk) => {
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    return copy.buffer as ArrayBuffer;
  });
  return new Blob(parts, { type: "application/octet-stream" });
}

/** Downloads an opaque backup artifact without parsing or retaining its contents. */
export async function downloadBackup(id: string): Promise<{ readonly blob: Blob; readonly filename: string }> {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) throw new Error("backup identifier is invalid");
  const response = await apiRaw(`/v2/admin/backups/${encodeURIComponent(id)}/download`, { method: "GET" });
  if (!response.ok) {
    throw new ApiError(response.status, response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "backup_download_failed", "backup download unavailable");
  }
  return { blob: await readBoundedBody(response, MAX_BACKUP_DOWNLOAD_BYTES), filename: safeBackupFilename(response.headers.get("content-disposition")?.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1] ?? null) };
}
/** Reads only bounded scope strings from the daemon session payload. */
export function parseAdminScopes(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.scopes)) return [];
  return value.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length <= 80).slice(0, 64);
}

/** Checks the daemon's wildcard and named admin scopes. */
export function hasAdminScope(scopes: readonly string[], required: string): boolean {
  return scopes.some((scope) => scope === "*" || scope === "admin" || scope === "admin:*" || scope === required);
}
