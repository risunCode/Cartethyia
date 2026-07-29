/**
 * Auth API — login/logout (public) + password change + session info (guarded).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { ensureSettings, setPasswordHash, bumpPasswordVersion } from "../db/repos/settings";
import { hashPassword, verifyPassword } from "../auth/password";
import { signConsoleJwt } from "../auth/jwt";
import { loginLimiter } from "../auth/limiter";
import { confirmPassword } from "../auth/reauth";
import { buildSessionClearCookie, buildSessionCookie, clientIp, isHttps } from "../auth/http";

export const authPublicRoutes = new Elysia({ prefix: "/console/api" }).post("/login", async ({ body, set, request }) => {
  const settings = await ensureSettings();
  const ip = clientIp(request, settings.runtime);

  const check = loginLimiter.check(ip);
  if (!check.allowed) {
    set.status = 429;
    return { ...consoleError("rate_limited", "too many failed attempts"), retryAfterSec: check.retryAfterSec };
  }

  const { password } = (body ?? {}) as { password?: string };
  const ok = typeof password === "string" && settings.passwordHash !== null && (await verifyPassword(password, settings.passwordHash));
  if (!ok) {
    const after = loginLimiter.recordFailure(ip);
    addAuditEvent("login.failed", { ip });
    if (!after.allowed) {
      set.status = 429;
      return { ...consoleError("rate_limited", "too many failed attempts"), retryAfterSec: after.retryAfterSec };
    }
    set.status = 401;
    return consoleError("unauthorized", "wrong password");
  }

  loginLimiter.recordSuccess(ip);
  const ttlSec = settings.runtime.sessionTtlHours * 3600;
  const token = await signConsoleJwt({ secret: settings.jwtSecret, pv: settings.passwordVersion, ttlSeconds: ttlSec });
  set.headers["set-cookie"] = buildSessionCookie(token, ttlSec, isHttps(request, settings.runtime));
  addAuditEvent("login.success", { ip });
  return { ok: true, expiresInSec: ttlSec };
});

export const authProtectedRoutes = new Elysia({ prefix: "/console/api" })
  .post("/logout", async ({ set }) => {
    set.headers["set-cookie"] = buildSessionClearCookie();
    return { ok: true };
  })
  .get("/session", async () => {
    const settings = await ensureSettings();
    return { role: "admin", passwordVersion: settings.passwordVersion, hasPassword: settings.passwordHash !== null };
  })
  .post("/settings/password", async ({ body, set }) => {
    const { currentPassword, newPassword, confirmPassword: confirm } = (body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    };
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      set.status = 400;
      return consoleError("invalid_request", "new password must be at least 8 characters");
    }
    if (newPassword !== confirm) {
      set.status = 400;
      return consoleError("invalid_request", "password confirmation does not match");
    }
    if (!(await confirmPassword(currentPassword))) {
      set.status = 401;
      return consoleError("unauthorized", "current password is wrong");
    }
    setPasswordHash(await hashPassword(newPassword));
    addAuditEvent("password.changed", {});
    return { ok: true, note: "all sessions invalidated; sign in again" };
  })
  .post("/settings/logout-all", async ({ body, set }) => {
    const { password } = (body ?? {}) as { password?: string };
    if (!(await confirmPassword(password))) {
      set.status = 401;
      return consoleError("unauthorized", "password is wrong");
    }
    bumpPasswordVersion();
    addAuditEvent("session.logout_all", {});
    set.headers["set-cookie"] = buildSessionClearCookie();
    return { ok: true };
  });
