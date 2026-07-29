/**
 * Console guard — anti-bypass + anti-IDOR (REQ-1.4..1.9) + ACL (REQ-15):
 * verifies JWT signature, expiry and password_version on every request;
 * enforces JSON content-type + same-origin on mutations; never trusts
 * client-supplied auth headers. ACL applies to all console routes.
 */

import { consoleError } from "../errors";
import { ensureSettings } from "../db/repos/settings";
import { checkAccess } from "../db/repos/access";
import { verifyConsoleJwt } from "./jwt";
import { isSameOrigin, readCookie, SESSION_COOKIE, clientIp } from "./http";

interface GuardContext {
  request: Request;
  set: { status?: number | string };
  server?: { requestIP(request: Request): { address: string } | null } | null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * ACL check for console scope (REQ-15) — applies to ALL console endpoints
 * (including public login and web pages). Uses `clientIp()` (trusts
 * x-forwarded-for when `trustProxy` runtime override is set) to stay
 * consistent with the existing console IP resolution helper.
 */
export async function consoleAclGuard({ request, set }: GuardContext): Promise<unknown> {
  const settings = await ensureSettings();
  if (!checkAccess("console", clientIp(request, settings.runtime))) {
    set.status = 403;
    return consoleError("forbidden", "your IP is not allowed to access the console");
  }
  return undefined;
}

export async function consoleBeforeHandle({ request, set }: GuardContext): Promise<unknown> {
  if (!SAFE_METHODS.has(request.method)) {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      set.status = 403;
      return consoleError("forbidden", "mutating console requests require Content-Type: application/json");
    }
    if (!isSameOrigin(request)) {
      set.status = 403;
      return consoleError("forbidden", "cross-origin console request rejected");
    }
  }

  const settings = await ensureSettings();
  const token = readCookie(request, SESSION_COOKIE);
  const result = await verifyConsoleJwt(token, {
    secret: settings.jwtSecret,
    expectedPv: settings.passwordVersion,
  });
  if (!result.ok) {
    set.status = 401;
    return consoleError("unauthorized", result.reason === "expired" ? "session expired" : "invalid session");
  }
  return undefined;
}
