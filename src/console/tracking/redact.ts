/**
 * Redaction utility — remove sensitive headers/fields from request/response payloads.
 */

const SENSITIVE_HEADER_PATTERNS = ["authorization", "proxy-authorization"];
const SENSITIVE_BODY_FIELDS = ["api_key", "token", "password", "credential", "bearer", "secret"];

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_PATTERNS.some((p) => lower.includes(p));
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string" || isSensitiveHeader(k)) continue;
    if (/^(bearer|sk-|pt-)\w/i.test(v)) out[k] = "[REDACTED]";
    else out[k] = v;
  }
  return out;
}

export function redactText(text: string): string {
  // Mask Bearer tokens, sk-xxx patterns, base64-ish secrets inside JSON-like strings
  let s = text.replace(/("bearer\s+\S+)"/gi, "$1[REDACTED]");
  s = s.replace(/(sk-[a-zA-Z0-9]{20,})/g, "sk-[REDACTED]");
  s = s.replace(/(pt-[a-zA-Z0-9]{20,})/g, "pt-[REDACTED]");
  s = s.replace(/("key":")([^"]{8,})("[\s\n\r:,])/g, "$1[REDACTED]$3");
  return s;
}

export function redactPayload(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  try {
    let str = typeof input === "string" ? input : JSON.stringify(input);
    for (const field of SENSITIVE_BODY_FIELDS) {
      str = str.replaceAll(`"${field}"`, `[${field.toUpperCase()}_REDACTED]`);
    }
    return redactText(str).slice(0, 50_000);
  } catch {
    return null;
  }
}
