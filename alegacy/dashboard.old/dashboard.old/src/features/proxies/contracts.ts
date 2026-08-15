import { DaemonContractError } from "../../lib/daemon-api";

export type ProxyProtocol = "http" | "https" | "socks4" | "socks5" | (string & {});

/** Public proxy record. Passwords are deliberately absent from this DTO. */
export interface ProxyRecord {
  id: string;
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  country: string | null;
  enabled: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
}
/** Write-only proxy input. A blank password means keep the existing secret. */
export interface ProxyInput {
  label: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  country?: string;
  enabled?: boolean;
}

export interface ProxySettings {
  mode: string;
  defaultProxy: string | null;
  allowList: string[];
  blockList: string[];
}

export interface ProxyTestResult {
  proxyId: string | null;
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface ProxyBatchResult {
  succeeded: number;
  failed: number;
  errors: string[];
}

export interface ProxyScrapeSource {
  id: string;
  label: string;
  protocols: string[];
  countryAware: boolean;
}

export interface ProxyValidationResult {
  valid: boolean;
  errors: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown, maxLength = 512): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new DaemonContractError("invalid_contract", `proxy ${field} is invalid`, 502);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new DaemonContractError("invalid_contract", `proxy ${field} is invalid`, 502);
  }
  return value;
}

/** Parses one daemon proxy record and drops unknown/secret-shaped fields. */
export function normalizeProxy(value: unknown): ProxyRecord {
  if (!isRecord(value)) throw new DaemonContractError("invalid_contract", "proxy record is invalid", 502);
  return {
    id: requiredString(value.id, "id"),
    label: stringOrNull(value.label) ?? "",
    protocol: requiredString(value.protocol, "protocol"),
    host: requiredString(value.host, "host"),
    port: boundedInteger(value.port, "port", 1, 65_535),
    username: stringOrNull(value.username, 256),
    country: stringOrNull(value.country, 64),
    enabled: typeof value.enabled === "boolean" ? value.enabled : null,
    createdAt: stringOrNull(value.createdAt, 128),
    updatedAt: stringOrNull(value.updatedAt, 128),
  };
}
/** Parses a bounded proxy list envelope payload. */
export function normalizeProxyList(value: unknown): ProxyRecord[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new DaemonContractError("invalid_contract", "proxy list is invalid", 502);
  }
  return value.items.slice(0, 500).map(normalizeProxy);
}

/** Parses proxy settings while preserving missing values as explicit null/empty state. */
export function normalizeProxySettings(value: unknown): ProxySettings {
  if (!isRecord(value) || typeof value.mode !== "string" || value.mode.length > 64) {
    throw new DaemonContractError("invalid_contract", "proxy settings are invalid", 502);
  }
  const toStrings = (input: unknown): string[] => Array.isArray(input)
    ? input.filter((entry): entry is string => typeof entry === "string" && entry.length <= 512).slice(0, 500)
    : [];
  return {
    mode: value.mode,
    defaultProxy: stringOrNull(value.defaultProxy, 512),
    allowList: toStrings(value.allowList),
    blockList: toStrings(value.blockList),
  };
}
export function sanitizeProbeDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/https?:\/\/([^\s/@:]+):([^\s/@]+)@/gi, "https://[redacted]@")
    .replace(/(authorization|cookie|password|passwd|secret|token|credential|api[-_]?key)\s*[:=]\s*[^,;\s]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}...` : sanitized || null;
}

/** Parses bounded connectivity evidence and never exposes raw provider details. */
export function normalizeProxyTestResult(value: unknown): ProxyTestResult {
  if (!isRecord(value) || typeof value.reachable !== "boolean") {
    throw new DaemonContractError("invalid_contract", "proxy test result is invalid", 502);
  }
  const statusCode = typeof value.statusCode === "number" && Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599
    ? value.statusCode
    : null;
  const latencyMs = typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0 && value.latencyMs <= 86_400_000
    ? value.latencyMs
    : null;
  return {
    proxyId: stringOrNull(value.proxyId, 128),
    reachable: value.reachable,
    statusCode,
    latencyMs,
    detail: sanitizeProbeDetail(value.detail),
  };
}

/** Parses import/scrape outcomes without retaining daemon metadata or credentials. */

export function normalizeProxyBatchResult(value: unknown): ProxyBatchResult {
  if (!isRecord(value)) throw new DaemonContractError("invalid_contract", "proxy batch result is invalid", 502);
  const errors = Array.isArray(value.errors)
    ? value.errors.filter((entry): entry is string => typeof entry === "string").map(sanitizeProbeDetail).filter((entry): entry is string => entry !== null).slice(0, 100)
    : [];
  return {
    succeeded: typeof value.succeeded === "number" && Number.isFinite(value.succeeded) ? Math.max(0, Math.trunc(value.succeeded)) : 0,
    failed: typeof value.failed === "number" && Number.isFinite(value.failed) ? Math.max(0, Math.trunc(value.failed)) : errors.length,
    errors,
  };
}

/** Parses daemon-advertised country filters without retaining unknown metadata. */
export function normalizeProxyCountries(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.countries)) throw new DaemonContractError("invalid_contract", "proxy countries are invalid", 502);
  return value.countries.filter((country): country is string => typeof country === "string" && country.length <= 64).slice(0, 250);
}

/** Parses scrape source metadata returned by the daemon. */
export function normalizeProxyScrapeSources(value: unknown): ProxyScrapeSource[] {
  if (!isRecord(value) || !Array.isArray(value.sources)) throw new DaemonContractError("invalid_contract", "proxy scrape catalog is invalid", 502);
  return value.sources.flatMap((source): ProxyScrapeSource[] => {
    if (!isRecord(source) || typeof source.id !== "string" || typeof source.label !== "string") return [];
    const protocols = Array.isArray(source.protocols) ? source.protocols.filter((entry): entry is string => typeof entry === "string").slice(0, 32) : [];
    return [{ id: source.id.slice(0, 128), label: source.label.slice(0, 256), protocols, countryAware: source.countryAware === true }];
  });
}

/** Validates proxy form values before a create/update mutation is attempted. */
export function validateProxyInput(input: ProxyInput): ProxyValidationResult {
  const errors: Record<string, string> = {};
  if (input.label.length > 256) errors.label = "Label is too long";
  if (!input.protocol.trim()) errors.protocol = "Protocol is required";
  if (!input.host.trim()) errors.host = "Host is required";
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) errors.port = "Port must be between 1 and 65535";
  if (input.username && input.username.length > 256) errors.username = "Username is too long";
  if (input.password && input.password.length > 2048) errors.password = "Password is too long";
  if (input.country && input.country.length > 64) errors.country = "Country is too long";
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Builds a daemon input shape while omitting blank write-only password values. */
export function toProxyInput(input: ProxyInput): Record<string, unknown> {
  const validation = validateProxyInput(input);
  if (!validation.valid) throw new DaemonContractError("invalid_input", "proxy fields are invalid", 400);
  const output: Record<string, unknown> = {
    label: input.label.trim(),
    protocol: input.protocol.trim(),
    host: input.host.trim(),
    port: input.port,
    enabled: input.enabled !== false,
  };
  if (input.username?.trim()) output.username = input.username.trim();
  if (input.country?.trim()) output.country = input.country.trim();
  if (input.password) output.password = input.password;
  return output;
}
