import { api, ApiError, sanitizeErrorMessage, type ConsoleHttpMethod } from "./api";
import { isDocumentedConsoleRoute } from "./console-routes";

/** Envelope emitted by the console's /v2/admin routes. */
export interface ConsoleEnvelope<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: {
    request_id?: string;
  };
}

export interface DashboardHealth {
  status: "ready" | "degraded" | "offline" | "unknown";
  dependencies: Readonly<Record<string, "ready" | "degraded" | "offline" | "unknown">>;
}

export interface DashboardSummary {
  version: string;
  environment: string;
  uptime: string;
  accountCount: number;
  proxyCount: number;
  apiKeyCount: number;
  health: DashboardHealth;
}

export interface TelemetryOverview {
  requests: number | null;
  errors: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  byRoute: Readonly<Record<string, number>>;
}

export interface TelemetryBucket {
  timestamp: string;
  count: number;
  errors: number;
  latencyMs: number | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  modelCount: number;
  accountCount: number;
  enabled: boolean;
  configured: boolean;
  credentialKind: "api_key" | "oauth" | "session" | "manual" | "none" | "unknown";
  models: readonly CatalogModel[];
}

export interface CatalogModel {
  id: string;
  enabled: boolean;
  capabilities: Readonly<Record<string, boolean>>;
}

export interface ConsoleAccount {
  id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  credentialHint: string | null;
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
}

const ADMIN_PREFIX = "/v2/admin";
const SECRET_KEY = /(?:password|passwd|secret|token|authorization|api[-_]?key|private[-_]?key|cookie|prompt|provider[_-]?response|response)/i;
const SAFE_CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_STRING_LENGTH = 512;
const MAX_REDACTION_COLLECTION_LENGTH = 128;
const SAFE_ERROR_CODE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Removes secret-shaped fields before an unknown console value can enter UI state. */
export function redactOperatorValue(value: unknown): unknown {
  const redact = (current: unknown, depth: number): unknown => {
    if (depth > MAX_REDACTION_DEPTH) return null;
    if (typeof current === "string") {
      return current.length <= MAX_REDACTION_STRING_LENGTH
        ? current
        : `${current.slice(0, MAX_REDACTION_STRING_LENGTH)}…`;
    }
    if (Array.isArray(current)) {
      return current.slice(0, MAX_REDACTION_COLLECTION_LENGTH).map((item) => redact(item, depth + 1));
    }
    if (!isRecord(current)) return current;
    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current).slice(0, MAX_REDACTION_COLLECTION_LENGTH)) {
      const isCredentialRef = key === "credentialRef";
      if (isCredentialRef) {
        if (typeof nested === "string" && SAFE_CREDENTIAL_REF.test(nested)) safe[key] = nested;
        continue;
      }
      if (key !== "credentialHint" && key !== "credentialKind" && key !== "apiKeyPrefix" && SECRET_KEY.test(key)) continue;
      safe[key] = redact(nested, depth + 1);
    }
    return safe;
  };
  return redact(value, 0);
}

/** Normalizes a successful console envelope and rejects malformed contracts. */
export function unwrapConsoleEnvelope<T>(value: unknown): T {
  if (!isRecord(value) || !("data" in value)) {
    throw new ConsoleContractError("invalid_contract", "daemon response envelope is invalid", 502);
  }
  if ("error" in value && value.error != null) {
    const error = isRecord(value.error) ? value.error : {};
    const code = typeof error.code === "string" && SAFE_ERROR_CODE.test(error.code) ? error.code : "invalid_contract";
    throw new ConsoleContractError(
      code,
      sanitizeErrorMessage(error.message, "daemon request failed"),
      502,
    );
  }
  return redactOperatorValue(value.data) as T;
}

/** Execute a typed console admin request through the same-origin V2 API client. */
export async function consoleApi<T>(route: string, init: RequestInit = {}): Promise<T> {
  const normalized = route.startsWith("/") ? route : `/${route}`;
  const method = (init.method ?? "GET").toUpperCase() as ConsoleHttpMethod;
  if (normalized.startsWith("/v1/") || normalized.startsWith("/v2/") || normalized.includes("://") || !isDocumentedConsoleRoute(normalized, method)) {
    throw new ConsoleContractError("invalid_route", "dashboard route is outside the retained V2 admin contract", 400);
  }
  const response = await api<ConsoleEnvelope<unknown>>(`${ADMIN_PREFIX}${normalized}`, init);
  return unwrapConsoleEnvelope<T>(response);
}

export const consoleGet = <T>(route: string) => consoleApi<T>(route, { method: "GET" });
export const consolePost = <T>(route: string, body?: unknown) => consoleApi<T>(route, { method: "POST", body: JSON.stringify(body ?? {}) });
export const consolePatch = <T>(route: string, body?: unknown) => consoleApi<T>(route, { method: "PATCH", body: JSON.stringify(body ?? {}) });
export const consoleDelete = <T>(route: string) => consoleApi<T>(route, { method: "DELETE" });

/** Converts console failures into bounded state suitable for an operator view. */
export function consoleFailure(error: unknown): { code: string; message: string; degraded: boolean } {
  if (error instanceof ApiError || error instanceof ConsoleContractError) {
    return {
      code: error.code,
      message: error.message,
      degraded: error.status === 404 || error.status === 501 || error.status >= 500 || error.code === "unavailable",
    };
  }
  return { code: "network_error", message: "daemon request failed", degraded: true };
}

/** Parses the redacted console summary contract without retaining arbitrary metadata. */
export function normalizeDashboardSummary(value: unknown): DashboardSummary {
  if (!isRecord(value)) throw new ConsoleContractError("invalid_contract", "dashboard summary is invalid", 502);
  const statusValue = isRecord(value.health) && typeof value.health.status === "string" ? value.health.status : "unknown";
  const status: DashboardHealth["status"] = statusValue === "ready" || statusValue === "degraded" || statusValue === "offline" ? statusValue : "unknown";
  const dependencies: Record<string, DashboardHealth["status"]> = {};
  if (isRecord(value.health) && isRecord(value.health.dependencies)) {
    for (const [name, state] of Object.entries(value.health.dependencies)) {
      if (state === "ready" || state === "degraded" || state === "offline" || state === "unknown") dependencies[name] = state;
    }
  }
  return {
    version: stringValue(value.version) ?? "unknown",
    environment: stringValue(value.environment) ?? "unknown",
    uptime: stringValue(value.uptime) ?? "unknown",
    accountCount: finiteNumber(value.accountCount) ?? 0,
    proxyCount: finiteNumber(value.proxyCount) ?? 0,
    apiKeyCount: finiteNumber(value.apiKeyCount) ?? 0,
    health: { status, dependencies },
  };
}

/** Parses console telemetry overview while preserving unavailable values as null. */
export function normalizeTelemetryOverview(value: unknown): TelemetryOverview {
  if (!isRecord(value)) throw new ConsoleContractError("invalid_contract", "telemetry overview is invalid", 502);
  const byRoute: Record<string, number> = {};
  if (isRecord(value.byRoute)) {
    for (const [route, count] of Object.entries(value.byRoute)) {
      const parsed = finiteNumber(count);
      if (parsed !== null) byRoute[route] = parsed;
    }
  }
  return {
    requests: finiteNumber(value.requests),
    errors: finiteNumber(value.errors),
    p50Ms: finiteNumber(value.p50Ms),
    p95Ms: finiteNumber(value.p95Ms),
    p99Ms: finiteNumber(value.p99Ms),
    byRoute,
  };
}

/** Parses a bounded telemetry bucket list returned by the console. */
export function normalizeTelemetryBuckets(value: unknown): TelemetryBucket[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new ConsoleContractError("invalid_contract", "telemetry buckets are invalid", 502);
  return value.items.flatMap((item): TelemetryBucket[] => {
    if (!isRecord(item) || typeof item.timestamp !== "string") return [];
    return [{ timestamp: item.timestamp, count: finiteNumber(item.count) ?? 0, errors: finiteNumber(item.errors) ?? 0, latencyMs: finiteNumber(item.latencyMs) }];
  });
}

/** Catalog routes are optional until the console advertises a catalog service. */
export async function consoleCatalog(): Promise<readonly CatalogProvider[]> {
  const value = await consoleGet<unknown>("/catalog/providers");
  if (!isRecord(value) || !Array.isArray(value.items)) throw new ConsoleContractError("invalid_contract", "catalog response is invalid", 502);
  return value.items.flatMap((item): CatalogProvider[] => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const models = Array.isArray(item.models)
      ? item.models.flatMap((model): CatalogModel[] => {
        if (!isRecord(model)) return [];
        const id = typeof model.id === "string" ? model.id : typeof model.modelId === "string" ? model.modelId : null;
        if (id === null) return [];
        const capabilities: Record<string, boolean> = {};
        if (isRecord(model.capabilities)) {
          for (const [key, flag] of Object.entries(model.capabilities)) {
            if (typeof flag === "boolean") capabilities[key] = flag;
          }
        }
        return [{ id, enabled: model.enabled !== false, capabilities }];
      })
      : [];
    return [{
      id: item.id,
      name: stringValue(item.name) ?? item.id,
      modelCount: finiteNumber(item.modelCount) ?? models.length,
      accountCount: finiteNumber(item.accountCount) ?? 0,
      enabled: item.enabled !== false,
      configured: item.configured === true,
      credentialKind: item.credentialKind === "api_key" || item.credentialKind === "oauth" || item.credentialKind === "session" || item.credentialKind === "manual" || item.credentialKind === "none" ? item.credentialKind : "unknown",
      models,
    }];
  });
}
export class ConsoleContractError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(sanitizeErrorMessage(message, "daemon request failed"));
    this.name = "ConsoleContractError";
    this.code = SAFE_ERROR_CODE.test(code) ? code : "invalid_contract";
    this.status = status;
  }
}
