import { GatewayError } from "../../../protocol/gateway-error";

/** Normalized Kimi web-session credential. */
export interface KimiWebCredentials {
  readonly accessToken: string;
}

function cookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return "";
}

function tokenFromRecord(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["accessToken", "access_token", "token"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return tokenFromRecord(record.kimiAuth) || tokenFromRecord(record["kimi-auth"]);
}

/** Parses an access token, localStorage JSON, or a Cookie header containing kimi-auth. */
export function parseKimiWebCredential(raw: string): KimiWebCredentials {
  const trimmed = raw.trim();
  if (!trimmed) throw new GatewayError("invalid_request", 400, "Kimi Web credential cannot be empty");
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    const token = tokenFromRecord(parsed);
    if (token) return { accessToken: token };
  }
  const cookieToken = cookieValue(trimmed, "kimi-auth");
  if (cookieToken.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(cookieToken); } catch { parsed = undefined; }
    const token = tokenFromRecord(parsed);
    if (token) return { accessToken: token };
  }
  if (cookieToken) return { accessToken: cookieToken };
  if (trimmed.includes("=")) throw new GatewayError("invalid_request", 400, "Kimi Web credential must contain access_token");
  return { accessToken: trimmed };
}

/** Encodes the normalized credential for encrypted account storage. */
export function encodeKimiWebCredential(creds: KimiWebCredentials): string {
  return JSON.stringify({ accessToken: creds.accessToken });
}
