// Shared secret-key predicates and the telemetry redaction policy. Keys whose
// values are auth/secret material are replaced with ***REDACTED***[secret-key];
// opaque encrypted reasoning is redacted, never reconstructed, as
// ***REDACTED***[encrypted]. The serializer carves out usage-counter names that
// merely look secret. The remaining policy — key masking, payload gating, rk_
// and IPv4 string shapes, and recursion — stays here.

const SECRET_TOKEN_KEYS = new Set([
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "auth_token",
  "authtoken",
  "api_token",
  "apitoken",
  "bearer_token",
  "bearertoken",
  "oauth_token",
  "oauthtoken",
  "session_token",
  "sessiontoken",
  "csrf_token",
  "csrftoken",
  "device_token",
  "devicetoken",
  "secret_token",
  "secrettoken",
]);

export function isSecretKeyName(lower: string): boolean {
  if (
    lower.includes("credential") ||
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower === "authorization" ||
    lower === "x-api-key" ||
    lower.includes("secret") ||
    lower.includes("password")
  ) {
    return true;
  }
  return SECRET_TOKEN_KEYS.has(lower) || (lower.endsWith("_token") && !lower.endsWith("_tokens"));
}

export function isOpaqueEncrypted(lower: string, value: unknown): boolean {
  if (lower.includes("encrypted")) return true;
  if (lower.includes("reasoning") && typeof value === "string" && value.length > 100) return true;
  if (lower === "reasoning" || lower === "encrypted_content" || lower === "encrypted_reasoning") {
    return true;
  }
  return false;
}

// Markers keep the existing `***REDACTED***` prefix for log consumers while
// identifying why a value was hidden during provider-payload diagnosis.
const REDACTED_CREDENTIAL = "***REDACTED***[credential]";
const REDACTED_SECRET_KEY = "***REDACTED***[secret-key]";
const REDACTED_IP = "***REDACTED***[ip]";

// Single telemetry redaction utility (key matching shared with the privacy
// serializer above; string shapes and recursion stay local).
export function redactTelemetryValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Embedded-token sweep (runs before the ^-anchored shapes below): a
    // serialized string like {"message":"Invalid auth: Bearer eyJ..."} does
    // not start with the credential, so the anchored checks miss it. Redact
    // the whole string whenever an embedded credential-shaped token appears.
    if (/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{16,}|rk_[A-Za-z0-9_-]{8,})\b/.test(value))
      return REDACTED_CREDENTIAL;
    // Credential-shaped strings.
    if (/^(sk-|Bearer |api_key|secret)/i.test(value)) return REDACTED_CREDENTIAL;
    // Reply-key prefixes: keep the 5-char hint, drop the secret tail.
    if (/^rk_[a-zA-Z0-9_-]+/.test(value)) return `${value.slice(0, 5)}***`;
    // IPv4 literals carry no analytic value in telemetry reads.
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(value)) return REDACTED_IP;
    return value;
  }
  if (Array.isArray(value)) return value.map(redactTelemetryValue);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (isSecretKeyName(lower)) {
        out[k] = REDACTED_SECRET_KEY;
        continue;
      }
      if (isOpaqueEncrypted(lower, v)) {
        // Encrypted reasoning is opaque: redact, never reconstruct.
        out[k] = "***REDACTED***[encrypted]";
        continue;
      }
      out[k] = redactTelemetryValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Masks a client IP for presentation: IPv4 keeps the first three octets
 * (`203.0.113.xxx`), IPv6 the first four hextets. Empty input stays empty;
 * unparseable input is fully masked. Mirrors the 21.beta privacy contract:
 * storage keeps raw values, only the read path masks.
 */
export function maskClientIp(value: string): string;
export function maskClientIp(value: null | undefined): null;
export function maskClientIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ip = value.trim();
  if (ip.length === 0) return ip;
  // IPv4-mapped IPv6 (`::ffff:203.0.113.7`): mask the embedded IPv4 tail so
  // the most common localhost/proxied shape stays readable.
  const lastColon = ip.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".");
    if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
      return `${ip.slice(0, lastColon + 1)}${octets.slice(0, 3).join(".")}.xxx`;
    }
    return "***";
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return parts.length >= 4 ? `${parts.slice(0, 4).join(":")}:xxxx` : "xxxx";
  }
  const octets = ip.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    return `${octets.slice(0, 3).join(".")}.xxx`;
  }
  return "***";
}
