/**
 * Console API contract readers shared by the Providers and Quota pages.
 *
 * Every reader targets a real API route — the Go API is the contract
 * authority, not the indicative route names in the web-dashboard spec:
 *   - GET  /accounts                      → { items: Account[] }
 *   - GET  /providers/:id/accounts        → { items: Account[] }
 *   - GET  /accounts/:id/quota            → QuotaState
 *   - GET  /catalog/providers             → { items: CatalogProvider[] }
 * Account records are emitted with Go field names (ID, Provider, Enabled, …)
 * while catalog rows carry both snake_case and camelCase aliases, so every
 * parser below accepts both spellings.
 */
import { ConsoleContractError, consoleFailure, consoleGet } from "@lib/console-api";

/** Per-refresh budget for quota probes on the Providers list aggregate. */
export const MAX_LIST_QUOTA_PROBES = 48;
/** Per-refresh budget for quota probes on detail views and the Quota page. */
export const MAX_DETAIL_QUOTA_PROBES = 100;
/** How many accounts of one provider feed the list-level quota aggregate. */
export const PER_PROVIDER_PROBE_LIMIT = 6;

export interface AccountRecord {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  readonly email: string | null;
  readonly enabled: boolean;
  readonly reauthRequired: boolean;
}

export interface ProviderModelEntry {
  readonly id: string;
  readonly enabled: boolean;
}

export interface ProviderCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly protocols: readonly string[];
  readonly credentialKinds: readonly string[];
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly accountCount: number;
  readonly modelCount: number;
  readonly enabledModelCount: number;
  readonly models: readonly ProviderModelEntry[];
}

/** Normalized view of the API's QuotaState contract for one account. */
export interface AccountQuotaWindow {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly remainingPercent: number | null;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly lastChecked: string | null;
  /** Retry hint when the API exposes one through QuotaState.extras. */
  readonly retryAt: string | null;
}

/**
 * Outcome of probing one account's quota endpoint. "unsupported" marks the
 * degraded case (404/501/5xx) where the provider has no quota contract, so
 * callers can filter the account out of quota views.
 */
export type QuotaProbeOutcome =
  | { readonly kind: "ready"; readonly window: AccountQuotaWindow }
  | { readonly kind: "unsupported"; readonly code: string }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

/** Aggregated quota windows across one provider's accounts. */
export interface QuotaAggregate {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly windows: number;
  readonly unsupported: number;
}

/** Narrows an unknown value to a plain record. */
export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a finite number or null. */
export function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Returns a trimmed, length-bounded string or null. */
export function toBoundedString(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  if (normalized.length === 0 || normalized.length > max) return null;
  return normalized;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const parsed = toFiniteNumber(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readString(record: Record<string, unknown>, keys: readonly string[], max?: number): string | null {
  for (const key of keys) {
    const parsed = max === undefined ? toBoundedString(record[key]) : toBoundedString(record[key], max);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return fallback;
}

function readStringList(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const items = value.flatMap((entry): string[] => {
      const parsed = toBoundedString(entry, 64);
      return parsed ? [parsed] : [];
    });
    if (items.length > 0) return items;
  }
  return [];
}

/** Parses one API account row; returns null when the row has no usable identity. */
export function normalizeAccountRecord(value: unknown): AccountRecord | null {
  if (!isRecordValue(value)) return null;
  const id = readString(value, ["id", "ID"], 128);
  const providerId = readString(value, ["providerId", "provider", "Provider"], 128);
  if (!id || !providerId) return null;
  return {
    id,
    providerId,
    label: readString(value, ["label", "name", "Name", "providerAccountId", "ProviderAccountID"], 128) ?? id,
    email: readString(value, ["email", "Email"], 190),
    enabled: readBoolean(value, ["enabled", "Enabled", "active"], true),
    reauthRequired: readBoolean(value, ["reauthRequired", "ReauthRequired", "reauth_required"], false),
  };
}

function parseAccountsPayload(value: unknown): readonly AccountRecord[] {
  if (!isRecordValue(value) || !Array.isArray(value.items)) {
    throw new ConsoleContractError("invalid_contract", "account list response is invalid", 502);
  }
  return value.items.flatMap((item): AccountRecord[] => {
    const account = normalizeAccountRecord(item);
    return account ? [account] : [];
  });
}

/** Lists every account across providers (GET /v2/admin/accounts). */
export async function fetchAllAccounts(): Promise<readonly AccountRecord[]> {
  return parseAccountsPayload(await consoleGet<unknown>("/accounts"));
}

/** Lists the accounts of one provider (GET /v2/admin/providers/:id/accounts). */
export async function fetchProviderScopedAccounts(providerId: string): Promise<readonly AccountRecord[]> {
  return parseAccountsPayload(await consoleGet<unknown>(`/providers/${encodeURIComponent(providerId)}/accounts`));
}

/** Parses the API QuotaState contract into a bounded quota window. */
export function normalizeQuotaWindow(value: unknown): AccountQuotaWindow | null {
  if (!isRecordValue(value)) return null;
  const limit = readNumber(value, ["limit"]) ?? 0;
  const percent = (part: number): number | null => (limit > 0 ? Math.max(-100, Math.min(100, (part / limit) * 100)) : null);
  const extras = isRecordValue(value.extras) ? value.extras : {};
  return {
    used: readNumber(value, ["used"]) ?? 0,
    limit,
    remaining: readNumber(value, ["remaining"]) ?? 0,
    remainingPercent: percent(readNumber(value, ["remaining"]) ?? 0),
    usedPercent: percent(readNumber(value, ["used"]) ?? 0),
    resetsAt: readString(value, ["resetsAt", "resets_at"], 64),
    lastChecked: readString(value, ["lastChecked", "last_checked"], 64),
    retryAt: readString(extras, ["retryAt", "retry_at", "retryAfter", "retry_after"], 64),
  };
}

/**
 * Reads one account's quota snapshot (GET /v2/admin/accounts/:id/quota) and
 * classifies failures: degraded responses mean the provider exposes no quota
 * contract, everything else is a surfaced account error.
 */
export async function fetchAccountQuota(accountId: string): Promise<QuotaProbeOutcome> {
  try {
    const window = normalizeQuotaWindow(await consoleGet<unknown>(`/accounts/${encodeURIComponent(accountId)}/quota`));
    return window
      ? { kind: "ready", window }
      : { kind: "error", code: "invalid_contract", message: "quota response is invalid" };
  } catch (cause) {
    const failure = consoleFailure(cause);
    return failure.degraded
      ? { kind: "unsupported", code: failure.code }
      : { kind: "error", code: failure.code, message: failure.message };
  }
}

/** Probes quota windows for the first `cap` accounts in parallel. */
export async function probeAccountQuotas(
  accounts: readonly AccountRecord[],
  cap: number,
): Promise<Map<string, QuotaProbeOutcome>> {
  const outcomes = new Map<string, QuotaProbeOutcome>();
  const targets = accounts.slice(0, Math.max(0, cap));
  await Promise.all(
    targets.map(async (account) => {
      outcomes.set(account.id, await fetchAccountQuota(account.id));
    }),
  );
  return outcomes;
}

/** Lists the redacted provider catalog (GET /v2/admin/catalog/providers). */
export async function fetchProviderCatalog(): Promise<readonly ProviderCatalogEntry[]> {
  const value = await consoleGet<unknown>("/catalog/providers");
  if (!isRecordValue(value) || !Array.isArray(value.items)) {
    throw new ConsoleContractError("invalid_contract", "catalog response is invalid", 502);
  }
  return value.items.flatMap((item): ProviderCatalogEntry[] => {
    if (!isRecordValue(item)) return [];
    const id = readString(item, ["id"], 128);
    if (!id) return [];
    const singleProtocol = readString(item, ["protocol"], 64);
    const protocols = [...(singleProtocol ? [singleProtocol] : []), ...readStringList(item, ["protocols", "Protocols"])];
    const credentialKinds = readStringList(item, ["credentialKinds", "credential_kinds", "CredentialKinds"]);
    const models = Array.isArray(item.models)
      ? item.models.flatMap((model): ProviderModelEntry[] => {
          if (!isRecordValue(model)) return [];
          const modelId = readString(model, ["id", "modelId"], 128);
          return modelId ? [{ id: modelId, enabled: readBoolean(model, ["enabled"], true) }] : [];
        })
      : [];
    return [{
      id,
      name: readString(item, ["name", "display_name", "displayName"], 128) ?? id,
      protocols: [...new Set(protocols)],
      credentialKinds: [...new Set(credentialKinds.length > 0 ? credentialKinds : [readString(item, ["credentialKind", "credential_kind"], 64) ?? "unknown"])],
      enabled: readBoolean(item, ["enabled"], true),
      configured: readBoolean(item, ["configured"], false),
      accountCount: readNumber(item, ["accountCount", "account_count"]) ?? 0,
      modelCount: readNumber(item, ["modelCount", "model_count"]) ?? models.length,
      enabledModelCount: models.filter((model) => model.enabled).length,
      models,
    }];
  });
}

/** True when the provider needs account credentials before it can route. */
export function providerRequiresCredentials(entry: ProviderCatalogEntry): boolean {
  if (entry.credentialKinds.length === 0) return false;
  return !entry.credentialKinds.every((kind) => kind === "none" || kind === "manual" || kind === "unknown");
}

/** Aggregates quota probe outcomes; returns null when nothing was probed. */
export function aggregateQuota(outcomes: readonly QuotaProbeOutcome[]): QuotaAggregate | null {
  let limit = 0;
  let used = 0;
  let remaining = 0;
  let windows = 0;
  let unsupported = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "unsupported") {
      unsupported += 1;
      continue;
    }
    if (outcome.kind !== "ready") continue;
    windows += 1;
    limit += Math.max(0, outcome.window.limit);
    used += Math.max(0, outcome.window.used);
    remaining += outcome.window.remaining;
  }
  if (windows === 0 && unsupported === 0) return null;
  return {
    limit,
    used,
    remaining,
    usedPercent: limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : null,
    remainingPercent: limit > 0 ? (remaining / limit) * 100 : null,
    windows,
    unsupported,
  };
}

/** Formats a quota percentage with a "—" fallback. */
export function formatQuotaPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "—";
}

/** Semantic bar tone for a used-percent value. */
export function quotaUsageTone(usedPercent: number | null | undefined): "success" | "warning" | "danger" {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return "success";
  if (usedPercent >= 80) return "danger";
  if (usedPercent >= 60) return "warning";
  return "success";
}

/**
 * Renders a future timestamp as a bounded countdown ("in 5m", "in 2h 05m",
 * "in 3d"). Past or unparseable values collapse to "pending" / "—".
 */
export function formatQuotaCountdown(iso: string | null | undefined): string {
  if (!iso) return "—";
  const timestamp = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(timestamp)) return "—";
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return "pending";
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `in ${Math.floor(hours / 24)}d`;
}
