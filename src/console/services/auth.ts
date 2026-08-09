import type { ConsoleErrorCode, SettingsRepository } from "../views";
import type { LoginLimiter } from "../session";
import { hashConsolePassword, MemoryLoginLimiter, signSessionToken, verifyConsolePassword } from "../session";

export interface LoginResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code: ConsoleErrorCode | null;
  readonly message: string | null;
  readonly token: string | null;
  readonly expiresInSec: number | null;
  readonly retryAfterSec: number | null;
}

/** Typed result for password-change / logout-all mutations. */
export interface AuthActionResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code: ConsoleErrorCode | null;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Application services
// ---------------------------------------------------------------------------

export class AuthService {
  // Cache guard inputs keyed by (updatedAt, passwordVersion). Every settings
  // mutation writes a fresh `updated_at`; every password/JWT change bumps
  // `password_version`. Re-reading the full snapshot (SQLite row + JSON parse
  // + bootstrap password/JWT rotation checks) on every authenticated console
  // request is wasteful when nothing changed — the guard runs on every hit.
  private cachedGuard: { readonly key: string; readonly result: { readonly jwtSecret: string; readonly passwordVersion: number; readonly trustProxy: boolean } } | null = null;

  constructor(
    private readonly settings: SettingsRepository,
    private readonly limiter: LoginLimiter = new MemoryLoginLimiter(),
  ) {}

  async login(password: unknown, ip: string, _request: Request): Promise<LoginResult> {
    const snapshot = await this.settings.get();
    const check = this.limiter.check(ip);
    if (!check.allowed) {
      return { ok: false, status: 429, code: "rate_limited", message: "too many failed attempts", token: null, expiresInSec: null, retryAfterSec: check.retryAfterSec };
    }
    const ok =
      typeof password === "string" &&
      snapshot.passwordHash !== null &&
      (await verifyConsolePassword(password, snapshot.passwordHash));
    if (!ok) {
      const after = this.limiter.recordFailure(ip);
      if (!after.allowed) {
        return { ok: false, status: 429, code: "rate_limited", message: "too many failed attempts", token: null, expiresInSec: null, retryAfterSec: after.retryAfterSec };
      }
      return { ok: false, status: 401, code: "unauthorized", message: "wrong password", token: null, expiresInSec: null, retryAfterSec: null };
    }
    this.limiter.recordSuccess(ip);
    const ttlSec = snapshot.runtime.sessionTtlHours * 3600;
    const token = await signSessionToken({ secret: snapshot.jwtSecret, pv: snapshot.passwordVersion, ttlSeconds: ttlSec });
    return { ok: true, status: 200, code: null, message: null, token, expiresInSec: ttlSec, retryAfterSec: null };
  }

  async session(): Promise<{ readonly role: "admin"; readonly passwordVersion: number; readonly hasPassword: boolean }> {
    const snapshot = await this.settings.get();
    return { role: "admin", passwordVersion: snapshot.passwordVersion, hasPassword: snapshot.passwordHash !== null };
  }

  /** Guard inputs: never returns the password hash, only what the guard needs. */
  async guardOptions(): Promise<{ readonly jwtSecret: string; readonly passwordVersion: number; readonly trustProxy: boolean }> {
    const snapshot = await this.settings.get();
    const key = `${snapshot.updatedAt}:${snapshot.passwordVersion}`;
    if (this.cachedGuard !== null && this.cachedGuard.key === key) return this.cachedGuard.result;
    const result = { jwtSecret: snapshot.jwtSecret, passwordVersion: snapshot.passwordVersion, trustProxy: snapshot.runtime.trustProxy };
    this.cachedGuard = { key, result };
    return result;
  }

  async changePassword(currentPassword: unknown, newPassword: unknown, confirm: unknown): Promise<AuthActionResult> {
    if (typeof newPassword !== "string" || newPassword.length < 5) {
      return { ok: false, status: 400, code: "invalid_request", message: "new password must be at least 5 characters" };
    }
    if (newPassword !== confirm) {
      return { ok: false, status: 400, code: "invalid_request", message: "password confirmation does not match" };
    }
    const snapshot = await this.settings.get();
    const verified =
      snapshot.passwordHash !== null &&
      typeof currentPassword === "string" &&
      (await verifyConsolePassword(currentPassword, snapshot.passwordHash));
    if (!verified) {
      return { ok: false, status: 401, code: "unauthorized", message: "current password is wrong" };
    }
    await this.settings.setPasswordHash(await hashConsolePassword(newPassword));
    return { ok: true, status: 200, code: null, message: "all sessions invalidated; sign in again" };
  }

  async logoutAll(password: unknown): Promise<AuthActionResult> {
    const snapshot = await this.settings.get();
    const verified =
      snapshot.passwordHash !== null &&
      typeof password === "string" &&
      (await verifyConsolePassword(password, snapshot.passwordHash));
    if (!verified) {
      return { ok: false, status: 401, code: "unauthorized", message: "password is wrong" };
    }
    await this.settings.bumpPasswordVersion();
    return { ok: true, status: 200, code: null, message: "" };
  }
}

