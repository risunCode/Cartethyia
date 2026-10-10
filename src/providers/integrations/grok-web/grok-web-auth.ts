import { GatewayError } from "../../../protocol/gateway-error";
import { webCookieValue } from "../shared/web-session";

/** Normalized Grok web-session credential. */
export interface GrokWebCredentials {
  readonly sso: string;
  readonly ssoRw: string;
  readonly cookie: string;
}

/** Parses JSON or a Cookie header containing both SSO cookies. */
export function parseGrokWebCredential(raw: string): GrokWebCredentials {
  const trimmed = raw.trim();
  if (!trimmed) throw new GatewayError("invalid_request", 400, "Grok Web credential cannot be empty");
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const sso = typeof record.sso === "string" ? record.sso.trim() : "";
      const ssoRw = typeof record["sso-rw"] === "string" ? record["sso-rw"].trim() : typeof record.ssoRw === "string" ? record.ssoRw.trim() : "";
      if (sso && ssoRw) return { sso, ssoRw, cookie: typeof record.cookie === "string" && record.cookie.trim() ? record.cookie : `sso=${sso}; sso-rw=${ssoRw}` };
    }
  }
  const sso = webCookieValue(trimmed, "sso");
  const ssoRw = webCookieValue(trimmed, "sso-rw");
  if (!sso || !ssoRw) throw new GatewayError("invalid_request", 400, "Grok Web credential must contain sso and sso-rw");
  return { sso, ssoRw, cookie: trimmed };
}

/** Encodes the normalized credential for encrypted account storage. */
export function encodeGrokWebCredential(creds: GrokWebCredentials): string {
  return JSON.stringify({ sso: creds.sso, ssoRw: creds.ssoRw, cookie: creds.cookie });
}

/** Returns the original cookie, or rebuilds the required pair. */
export function grokWebCookieHeader(creds: GrokWebCredentials): string {
  return creds.cookie || `sso=${creds.sso}; sso-rw=${creds.ssoRw}`;
}
