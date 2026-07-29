/**
 * Settings API — runtime toggles and backup/restore (REQ-5).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { ensureSettings, patchRuntimeSettings, rotateJwtSecret } from "../db/repos/settings";
import { invalidateRuntimeSettings } from "../runtime";
import { addAuditEvent } from "../db/repos/audit";
import { confirmPassword } from "../auth/reauth";
import { exportBackup } from "../backup/export";
import { validateRestorePayload, applyRestore } from "../backup/restore";
import type { RuntimeSettings } from "../db/repos/settings";
import type { TrackMode, ProxyAuthMode } from "../env";

const TRACK_MODES: TrackMode[] = ["none", "meta", "store"];
const PROXY_AUTH_MODES: ProxyAuthMode[] = ["open", "api_key"];

function validateRuntimePatch(patch: Partial<RuntimeSettings>): string | null {
  if (patch.proxyAuthMode !== undefined && !PROXY_AUTH_MODES.includes(patch.proxyAuthMode)) {
    return `proxyAuthMode must be one of ${PROXY_AUTH_MODES.join(", ")}`;
  }
  if (patch.trackPayloads !== undefined && !TRACK_MODES.includes(patch.trackPayloads)) {
    return `trackPayloads must be one of ${TRACK_MODES.join(", ")}`;
  }
  if (patch.trackAssets !== undefined && !TRACK_MODES.includes(patch.trackAssets)) {
    return `trackAssets must be one of ${TRACK_MODES.join(", ")}`;
  }
  if (patch.logRetentionDays !== undefined && (!Number.isFinite(patch.logRetentionDays) || patch.logRetentionDays < 1 || patch.logRetentionDays > 365)) {
    return "logRetentionDays must be 1–365";
  }
  if (patch.assetRetentionDays !== undefined && (!Number.isFinite(patch.assetRetentionDays) || patch.assetRetentionDays < 1 || patch.assetRetentionDays > 365)) {
    return "assetRetentionDays must be 1–365";
  }
  if (patch.maxFlightsPerIp !== undefined && (!Number.isFinite(patch.maxFlightsPerIp) || patch.maxFlightsPerIp < 1 || patch.maxFlightsPerIp > 100)) {
    return "maxFlightsPerIp must be 1–100";
  }
  if (patch.trustProxy !== undefined && typeof patch.trustProxy !== "boolean") {
    return "trustProxy must be a boolean";
  }
  if (patch.cacheMarkersEnabled !== undefined && typeof patch.cacheMarkersEnabled !== "boolean") {
    return "cacheMarkersEnabled must be a boolean";
  }
  // opencode-free models are always accessible to any valid API key — no access-mode setting exists.
  if (patch.systemPrompt !== undefined && typeof patch.systemPrompt !== "string") {
    return "systemPrompt must be a string";
  }
  if (patch.sessionTtlHours !== undefined && (!Number.isFinite(patch.sessionTtlHours) || patch.sessionTtlHours < 1 || patch.sessionTtlHours > 720)) {
    return "sessionTtlHours must be 1–720";
  }
  if (patch.costPerMillionInputTokens !== undefined && (!Number.isFinite(patch.costPerMillionInputTokens) || patch.costPerMillionInputTokens < 0)) {
    return "costPerMillionInputTokens must be a non-negative number";
  }
  if (patch.costPerMillionOutputTokens !== undefined && (!Number.isFinite(patch.costPerMillionOutputTokens) || patch.costPerMillionOutputTokens < 0)) {
    return "costPerMillionOutputTokens must be a non-negative number";
  }
  return null;
}

export const settingsRoutes = new Elysia({ prefix: "/console/api" })
  .get("/settings", async () => {
    const settings = await ensureSettings();
    return {
      hasPassword: settings.passwordHash !== null,
      passwordVersion: settings.passwordVersion,
      updatedAt: settings.updatedAt,
      settings: settings.runtime,
    };
  })
  .post("/settings", async ({ body, set }) => {
    const patch = (body ?? {}) as Partial<RuntimeSettings>;
    const error = validateRuntimePatch(patch);
    if (error) {
      set.status = 400;
      return consoleError("invalid_request", error);
    }
    const next = patchRuntimeSettings(patch);
    invalidateRuntimeSettings();
    addAuditEvent("settings.patch", patch as unknown as Record<string, unknown>);
    return { ok: true, settings: next };
  })
  .get("/settings/backup", async ({ headers, query, set }) => {
    const password = headers["x-console-password"];
    if (!(await confirmPassword(password))) {
      set.status = 401;
      addAuditEvent("backup.export.denied", {});
      return consoleError("unauthorized", "invalid password");
    }
    const includeHistory = query?.includeHistory === "true";
    const backup = exportBackup(includeHistory);
    addAuditEvent("backup.exported", { includeHistory });
    set.headers["Content-Disposition"] = `attachment; filename="cartethyia-backup-${new Date().toISOString().slice(0, 10)}.json"`;
    return backup;
  })
  .post("/settings/restore", async ({ body, set }) => {
    const { password, backup } = (body ?? {}) as { password?: string; backup?: unknown };
    if (!(await confirmPassword(password))) {
      set.status = 401;
      addAuditEvent("backup.restore.denied", {});
      return consoleError("unauthorized", "invalid password");
    }
    const validation = validateRestorePayload(backup);
    if (!validation.ok) {
      set.status = 400;
      addAuditEvent("backup.restore.invalid", { error: validation.error });
      return consoleError("invalid_request", validation.error);
    }
    try {
      const result = applyRestore(validation);
      invalidateRuntimeSettings();
      addAuditEvent("backup.restored", result.restored);
      return { ok: true, ...result };
    } catch (err) {
      set.status = 500;
      addAuditEvent("backup.restore.failed", { error: String(err) });
      return consoleError("internal", "restore failed");
    }
  })
  .post("/settings/rotate-jwt-secret", async ({ body, set }) => {
    const { password } = (body ?? {}) as { password?: string };
    if (!(await confirmPassword(password))) {
      set.status = 401;
      addAuditEvent("settings.rotate_jwt.denied", {});
      return consoleError("unauthorized", "invalid password");
    }
    rotateJwtSecret();
    invalidateRuntimeSettings();
    addAuditEvent("settings.rotate_jwt", {});
    return { ok: true };
  });
