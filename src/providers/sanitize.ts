// ---------------------------------------------------------------------------
// Third-party response validation
//
// Provider adapters decode payloads from external services. Even when a
// transport schema validates *structure*, the *content* is untrusted: a
// compromised or misbehaving upstream can return oversized arrays, control
// characters, non-finite numbers, or a base URL that redirects authenticated
// follow-up traffic to an attacker-controlled host. These helpers bound and
// sanitize that data before it reaches routing, storage, or the next outbound
// request (OWASP API10:2023 — Unsafe Consumption of APIs).
// ---------------------------------------------------------------------------

/** Default cap for a single upstream-provided label or identifier. */
export const MAX_UPSTREAM_LABEL_LENGTH = 256;
/** Default cap for an upstream-provided list (models, accounts, tools). */
export const MAX_UPSTREAM_LIST_ITEMS = 10_000;

// All C0/C1 controls including newlines — for labels/identifiers.
const LABEL_UNSAFE_CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

function clean(value: unknown, pattern: RegExp, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(pattern, "").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Sanitizes an upstream identifier/label: removes every control character
 * (including newlines), trims, and caps length. Returns `undefined` when
 * nothing usable remains.
 */
export function sanitizeUpstreamLabel(
  value: unknown,
  maxLength = MAX_UPSTREAM_LABEL_LENGTH,
): string | undefined {
  return clean(value, LABEL_UNSAFE_CONTROL, maxLength);
}

export interface UpstreamNumberBounds {
  readonly min?: number;
  readonly max?: number;
}

/**
 * Parses and range-checks an upstream numeric field. Returns `undefined` for
 * non-numeric, non-finite, or out-of-range values so callers apply their own
 * fallback instead of trusting an attacker-controlled number.
 */
export function boundedUpstreamNumber(
  value: unknown,
  bounds: UpstreamNumberBounds = {},
): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const min = bounds.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  if (parsed < min || parsed > max) return undefined;
  return parsed;
}

/**
 * Bounds an upstream array to `maxItems`. An over-long array is truncated
 * rather than rejected so a single unexpected entry cannot discard an
 * otherwise usable catalog. The typed overload preserves the element type for
 * callers that already decoded a schema; the untyped overload returns
 * `undefined` when the value is not an array.
 */
export function boundedUpstreamArray<T>(value: readonly T[], maxItems?: number): readonly T[];
export function boundedUpstreamArray(
  value: unknown,
  maxItems?: number,
): readonly unknown[] | undefined;
export function boundedUpstreamArray(
  value: unknown,
  maxItems = MAX_UPSTREAM_LIST_ITEMS,
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value as readonly unknown[];
  return items.length > maxItems ? items.slice(0, maxItems) : items;
}

export interface UpstreamBaseUrlOptions {
  /** Allow `http:` in addition to `https:` (private/dev upstreams only). */
  readonly allowHttp?: boolean;
  /** When set, the URL host must be one of these exact hosts. */
  readonly allowedHosts?: readonly string[];
}

/**
 * Validates an upstream-supplied absolute base URL. Only `https:` (or `http:`
 * when explicitly allowed) is accepted; embedded credentials and fragments are
 * rejected so a malicious upstream cannot redirect authenticated requests to a
 * different origin or downgrade transport. Returns the normalized URL without a
 * trailing slash, or `undefined` when invalid.
 */
export function validateUpstreamBaseUrl(
  value: unknown,
  options: UpstreamBaseUrlOptions = {},
): string | undefined {
  const raw = sanitizeUpstreamLabel(value, 2_048);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  if (url.protocol !== "https:" && !(options.allowHttp === true && url.protocol === "http:")) {
    return undefined;
  }
  if (options.allowedHosts && !options.allowedHosts.includes(url.hostname)) return undefined;
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}
