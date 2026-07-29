/** Shared request helpers: cookies, client IP, same-origin check. */

import type { RuntimeSettings } from "../db/repos/settings";

export const SESSION_COOKIE = "cartethyia_console";

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function clientIp(request: Request, runtime: Pick<RuntimeSettings, "trustProxy">): string {
  if (runtime.trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
  }
  return request.headers.get("x-real-ip") ?? "127.0.0.1";
}

export function isHttps(request: Request, runtime: Pick<RuntimeSettings, "trustProxy">): boolean {
  if (runtime.trustProxy && request.headers.get("x-forwarded-proto") === "https") return true;
  return request.url.startsWith("https://");
}

/**
 * Same-origin guard for mutating console calls: when an Origin header is
 * present its host must match the request Host. Absent Origin (curl, server
 * clients) is allowed — CSRF protection is layered on SameSite=Lax anyway.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
    return originHost === host;
  } catch {
    return false;
  }
}

export function buildSessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/console",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/console; HttpOnly; SameSite=Lax; Max-Age=0`;
}
