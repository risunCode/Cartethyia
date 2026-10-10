import { GatewayError } from "../../../protocol/gateway-error";

/** Normalized Claude web-session credential. */
export interface ClaudeWebCredentials {
  readonly sessionKey: string;
  readonly cookie: string;
}

const SESSION_KEY = /^sk-ant-[A-Za-z0-9_-]+$/;

function cookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function cookieFromExtension(value: unknown): ClaudeWebCredentials | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs = value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.name === "string" && typeof record.value === "string" ? [[record.name, record.value] as const] : [];
  });
  const sessionKey = pairs.find(([name]) => name === "sessionKey")?.[1]?.trim() ?? "";
  if (!sessionKey) return undefined;
  return { sessionKey, cookie: pairs.map(([name, item]) => `${name}=${item}`).join("; ") };
}

/** Parses a session key, normalized JSON, Cookie header, or extension cookie export. */
export function parseClaudeWebCredential(raw: string): ClaudeWebCredentials {
  const trimmed = raw.trim();
  if (!trimmed) throw new GatewayError("invalid_request", 400, "Claude Web credential cannot be empty");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    const exported = cookieFromExtension(parsed);
    if (exported) return exported;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const nested = cookieFromExtension(record.cookies);
      if (nested) return nested;
      if (typeof record.sessionKey === "string" && record.sessionKey.trim()) {
        const sessionKey = record.sessionKey.trim();
        return { sessionKey, cookie: typeof record.cookie === "string" && record.cookie.trim() ? record.cookie : `sessionKey=${sessionKey}` };
      }
    }
  }
  if (SESSION_KEY.test(trimmed)) return { sessionKey: trimmed, cookie: `sessionKey=${trimmed}` };
  const sessionKey = cookieValue(trimmed, "sessionKey");
  if (!sessionKey) throw new GatewayError("invalid_request", 400, "Claude Web credential must contain sessionKey");
  return { sessionKey, cookie: trimmed };
}

/** Encodes the normalized credential for encrypted account storage. */
export function encodeClaudeWebCredential(creds: ClaudeWebCredentials): string {
  return JSON.stringify({ sessionKey: creds.sessionKey, cookie: creds.cookie });
}

/** Returns the stored Cookie header unchanged. */
export function claudeWebCookieHeader(creds: ClaudeWebCredentials): string {
  return creds.cookie;
}
