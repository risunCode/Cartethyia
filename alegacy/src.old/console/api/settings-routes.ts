import { Elysia } from "elysia";
import { MAX_BACKUP_BYTES } from "../../storage";
import { convert9RouterBackup } from "../compat/9router";
import { buildSessionClearCookie, consoleError, type ConsoleServices } from "../services/composition";
import { ok } from "./route-helpers";

export interface SettingsRouteDependencies {
  readonly services: ConsoleServices;
  readonly resetConfig: () => void;
  readonly resetRuntime: () => void;
}


/** Registers authentication-session, settings, and backup routes. */
export function registerSettingsRoutes<T extends Elysia<any, any, any, any, any, any>>(app: T, deps: SettingsRouteDependencies): T {
  const { services } = deps;
  return app
    .post("/logout", ({ set }) => {
      set.headers["set-cookie"] = buildSessionClearCookie();
      return ok();
    })
    .route("QUERY", "/session", async () => services.auth.session())
    .post("/settings/password", async ({ body, set }) => {
      const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const result = await services.auth.changePassword(value.currentPassword, value.newPassword, value.confirmPassword);
      if (!result.ok) {
        set.status = result.status;
        return consoleError(result.code ?? "invalid_request", result.message);
      }
      return ok({ note: result.message });
    })
    .post("/settings/logout-all", async ({ body, set }) => {
      const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const result = await services.auth.logoutAll(value.password);
      if (!result.ok) {
        set.status = result.status;
        return consoleError(result.code ?? "unauthorized", result.message);
      }
      set.headers["set-cookie"] = buildSessionClearCookie();
      return ok();
    })
    .route("QUERY", "/settings", async () => ({ settings: await services.settings.get() }))
    .post("/settings", async ({ body }) => ({ settings: await services.settings.patchRuntime(body) }))
    .post("/settings/reset-all", async ({ body, set }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const result = await services.backup.resetAll(value.password, value.confirmation, deps.resetConfig, deps.resetRuntime);
      if (!result.ok) { set.status = result.status; return consoleError(result.code ?? "invalid_request", result.message); }
      return { ok: true, message: result.message };
    })
    .route("QUERY", "/settings/backup", async ({ request, set }) => {
      const verified = await services.backup.verifyPassword(request.headers.get("x-console-password"));
      if (!verified.ok) {
        set.status = verified.status;
        return consoleError(verified.code ?? "unauthorized", verified.message);
      }
      const payload = services.backup.exportBackup();
      set.headers["content-type"] = "application/json; charset=utf-8";
      set.headers["content-disposition"] = `attachment; filename="cartethyia-backup-${new Date().toISOString().slice(0, 10)}.json"`;
      set.headers["cache-control"] = "no-store";
      return payload;
    })
    .post("/settings/restore", async ({ body, request, set }) => {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > MAX_BACKUP_BYTES) {
        set.status = 413;
        return consoleError("request_too_large", `backup payload exceeds ${MAX_BACKUP_BYTES} bytes`);
      }
      const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const result = await services.backup.restore(value.password, value.backup);
      if (!result.ok) {
        set.status = result.status;
        return consoleError(result.code ?? "invalid_request", result.message);
      }
      return ok();
    })
    .post("/settings/restore/9router", async ({ body, request, set }) => {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > MAX_BACKUP_BYTES) { set.status = 413; return consoleError("request_too_large", "9router payload is too large"); }
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      try {
        const conversion = convert9RouterBackup(value.backup ?? value);
        const result = await services.backup.restore(value.password, conversion.backup);
        if (!result.ok) { set.status = result.status; return consoleError(result.code ?? "invalid_request", result.message); }
        return { ok: true, report: conversion.report };
      } catch (error) {
        set.status = 400;
        return consoleError("invalid_request", error instanceof Error ? error.message : "invalid 9router backup");
      }
    }) as unknown as T;
}
