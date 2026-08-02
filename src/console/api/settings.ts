/**
 * Settings API — runtime toggles and backup/restore (REQ-5).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { mutationLimiter, checkMutationLimit } from "../rate-limit";
import { ensureSettings, patchRuntimeSettings, rotateJwtSecret } from "../db/repos/settings";
import { invalidateProxyPoolSettingsCache } from "../db/repos/proxy-settings";
import { invalidateRuntimeSettings } from "../runtime";
import { addAuditEvent } from "../db/repos/audit";
import { confirmPassword } from "../auth/reauth";
import { exportBackup } from "../backup/export";
import { validateRestorePayload, applyRestore } from "../backup/restore";
import { convert9RouterBackup } from "../backup/compat/9router";
import { pushConsoleLog } from "../logs/ring";
import { numericRangeError } from "../../utils/config-helpers";
import { isOneOf } from "../../shared/guards";
import type { RuntimeSettings } from "../db/repos/settings";
import type { PayloadTrackMode, TrackMode, ProxyAuthMode } from "../env";

const PAYLOAD_TRACK_MODES: PayloadTrackMode[] = ["none", "meta"];
const ASSET_TRACK_MODES: TrackMode[] = ["none", "meta", "store"];
const PROXY_AUTH_MODES: ProxyAuthMode[] = ["open", "api_key"];

function isNineRouterBackup(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { providerConnections?: unknown; proxyPools?: unknown };
  return Array.isArray(candidate.providerConnections) && Array.isArray(candidate.proxyPools);
}

const RUNTIME_SETTINGS_KEYS = [
  "proxyAuthMode", "trackPayloads", "trackAssets", "logRetentionDays", "assetRetentionDays",
  "maxFlightsPerIp", "trustProxy", "cacheMarkersEnabled", "sessionTtlHours",
] as const satisfies readonly (keyof RuntimeSettings)[];

/**
 * Drops any key not in `RuntimeSettings` before it reaches `patchRuntimeSettings`.
 * Without this, an unrecognized field (a stale client sending a since-removed
 * setting, e.g. the deleted `systemPrompt`) would silently merge into and
 * persist forever in `settings_json`, inert but never cleaned up.
 */
function stripUnknownSettingsKeys(patch: Record<string, unknown>): Partial<RuntimeSettings> {
  const clean: Partial<RuntimeSettings> = {};
  for (const key of RUNTIME_SETTINGS_KEYS) {
    if (key in patch) (clean as Record<string, unknown>)[key] = patch[key];
  }
  return clean;
}

function validateRuntimePatch(patch: Partial<RuntimeSettings>): string | null {
  if (patch.proxyAuthMode !== undefined && !isOneOf(patch.proxyAuthMode, PROXY_AUTH_MODES)) {
    return `proxyAuthMode must be one of ${PROXY_AUTH_MODES.join(", ")}`;
  }
  if (patch.trackPayloads !== undefined && !isOneOf(patch.trackPayloads, PAYLOAD_TRACK_MODES)) {
    return `trackPayloads must be one of ${PAYLOAD_TRACK_MODES.join(", ")}`;
  }
  if (patch.trackAssets !== undefined && !isOneOf(patch.trackAssets, ASSET_TRACK_MODES)) {
    return `trackAssets must be one of ${ASSET_TRACK_MODES.join(", ")}`;
  }
  const rangeError =
    numericRangeError(patch.logRetentionDays, "logRetentionDays", 1, 365) ??
    numericRangeError(patch.assetRetentionDays, "assetRetentionDays", 1, 365) ??
    numericRangeError(patch.maxFlightsPerIp, "maxFlightsPerIp", 1, 100) ??
    numericRangeError(patch.sessionTtlHours, "sessionTtlHours", 1, 720);
  if (rangeError) return rangeError;
  if (patch.trustProxy !== undefined && typeof patch.trustProxy !== "boolean") {
    return "trustProxy must be a boolean";
  }
  if (patch.cacheMarkersEnabled !== undefined && typeof patch.cacheMarkersEnabled !== "boolean") {
    return "cacheMarkersEnabled must be a boolean";
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
  .post("/settings", async ({ body, set, request }) => {
    const rateLimited = checkMutationLimit(request);
    if (rateLimited) return rateLimited;
    const patch = stripUnknownSettingsKeys((body ?? {}) as Record<string, unknown>);
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
  .post("/settings/restore", async ({ body, set, request }) => {
    const rateLimited = checkMutationLimit(request);
    if (rateLimited) return rateLimited;
    const { password, backup } = (body ?? {}) as { password?: string; backup?: unknown };
    if (!(await confirmPassword(password))) {
      set.status = 401;
      addAuditEvent("backup.restore.denied", {});
      return consoleError("unauthorized", "invalid password");
    }
    if (isNineRouterBackup(backup)) {
      try {
        const conversion = convert9RouterBackup(backup);
        const validation = validateRestorePayload(conversion.backup);
        if (!validation.ok) {
          set.status = 400;
          addAuditEvent("backup.9router.restore.invalid", { error: validation.error });
          return consoleError("invalid_request", validation.error);
        }
        const result = applyRestore(validation);
        invalidateRuntimeSettings();
        invalidateProxyPoolSettingsCache();
        pushConsoleLog("info", "backup", `9router import completed accounts=${conversion.report.imported.accounts} proxies=${conversion.report.imported.proxies} apiKeys=${conversion.report.imported.apiKeys} aliases=${conversion.report.imported.aliases} combos=${conversion.report.imported.combos}`);
        for (const skipped of conversion.report.skipped.unsupportedProviders) {
          pushConsoleLog("warn", "backup", `9router skipped unsupported provider=${skipped.provider} count=${skipped.count}`);
        }
        if (conversion.report.skipped.invalidConnections.length > 0) {
          pushConsoleLog("warn", "backup", `9router skipped invalid connections count=${conversion.report.skipped.invalidConnections.length}`);
        }
        if (conversion.report.skipped.invalidProxies.length > 0) {
          pushConsoleLog("warn", "backup", `9router skipped invalid proxies count=${conversion.report.skipped.invalidProxies.length}`);
        }
        if (conversion.report.skipped.unsupportedNodes.length > 0) {
          pushConsoleLog("warn", "backup", `9router skipped provider nodes count=${conversion.report.skipped.unsupportedNodes.length}`);
        }
        for (const dropped of conversion.report.skipped.droppedFields) {
          pushConsoleLog("warn", "backup", `9router dropped field=${dropped.field} count=${dropped.count}`);
        }
        for (const warning of conversion.report.warnings) {
          pushConsoleLog("warn", "backup", `9router warning=${warning}`);
        }
        addAuditEvent("backup.9router.restored", { imported: conversion.report.imported });
        return { ok: true, ...result, compatibility: conversion.report };
      } catch (error) {
        set.status = 400;
        const message = error instanceof Error ? error.message : "invalid 9router backup";
        addAuditEvent("backup.9router.restore.failed", { error: message });
        return consoleError("invalid_request", message);
      }
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
  .post("/settings/restore/9router", async ({ body, set, request }) => {
    const rateLimited = checkMutationLimit(request);
    if (rateLimited) return rateLimited;
    const { password, backup } = (body ?? {}) as { password?: string; backup?: unknown };
    if (!(await confirmPassword(password))) {
      set.status = 401;
      addAuditEvent("backup.9router.restore.denied", {});
      return consoleError("unauthorized", "invalid password");
    }

    try {
      const conversion = convert9RouterBackup(backup);
      const validation = validateRestorePayload(conversion.backup);
      if (!validation.ok) {
        set.status = 400;
        addAuditEvent("backup.9router.restore.invalid", { error: validation.error });
        return consoleError("invalid_request", validation.error);
      }
      const result = applyRestore(validation);
      invalidateRuntimeSettings();
      invalidateProxyPoolSettingsCache();
      pushConsoleLog("info", "backup", `9router import completed accounts=${conversion.report.imported.accounts} proxies=${conversion.report.imported.proxies} apiKeys=${conversion.report.imported.apiKeys} aliases=${conversion.report.imported.aliases} combos=${conversion.report.imported.combos}`);
      for (const skipped of conversion.report.skipped.unsupportedProviders) {
        pushConsoleLog("warn", "backup", `9router skipped unsupported provider=${skipped.provider} count=${skipped.count}`);
      }
      if (conversion.report.skipped.invalidConnections.length > 0) {
        pushConsoleLog("warn", "backup", `9router skipped invalid connections count=${conversion.report.skipped.invalidConnections.length}`);
      }
      if (conversion.report.skipped.invalidProxies.length > 0) {
        pushConsoleLog("warn", "backup", `9router skipped invalid proxies count=${conversion.report.skipped.invalidProxies.length}`);
      }
      if (conversion.report.skipped.unsupportedNodes.length > 0) {
        pushConsoleLog("warn", "backup", `9router skipped provider nodes count=${conversion.report.skipped.unsupportedNodes.length}`);
      }
      for (const dropped of conversion.report.skipped.droppedFields) {
        pushConsoleLog("warn", "backup", `9router dropped field=${dropped.field} count=${dropped.count}`);
      }
      for (const warning of conversion.report.warnings) {
        pushConsoleLog("warn", "backup", `9router warning=${warning}`);
      }
      addAuditEvent("backup.9router.restored", {
        imported: conversion.report.imported,
        skippedProviders: conversion.report.skipped.unsupportedProviders.map(({ provider, count }) => ({ provider, count })),
        invalidConnections: conversion.report.skipped.invalidConnections.length,
        invalidProxies: conversion.report.skipped.invalidProxies.length,
        unsupportedNodes: conversion.report.skipped.unsupportedNodes.length,
      });
      return { ok: true, ...result, compatibility: conversion.report };
    } catch (error) {
      set.status = 400;
      const message = error instanceof Error ? error.message : "invalid 9router backup";
      addAuditEvent("backup.9router.restore.failed", { error: message });
      return consoleError("invalid_request", message);
    }
  })
  .post("/settings/rotate-jwt-secret", async ({ body, set, request }) => {
    const rateLimited = checkMutationLimit(request);
    if (rateLimited) return rateLimited;
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
