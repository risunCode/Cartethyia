/**
 * Provider accounts API — credential CRUD for provider accounts (REQ-20).
 *
 * Split from providers.ts alongside provider-catalog.ts: this file owns the
 * credentials that let dispatch reach a provider; provider-catalog.ts owns
 * what the provider IS and CAN DO (models, routing strategy). providers.ts
 * composes both under one Elysia instance.
 */

import { Elysia, t } from "elysia";
import { consoleError } from "../errors";
import { isProviderId, accountCredentialKindOf } from "../../routing/providerMeta";
import { importAccountsForProvider } from "../import/importAccounts";
import { addAuditEvent } from "../db/repos/audit";
import { tokenKeeper } from "../../tokenkeeper";
import { importOAuthCredential, type OAuthImportProvider } from "../../shared/oauthImport";
import {
  accountsVersion,
  listAccountsPage,
  getAccount,
  createAccount,
  patchAccount,
  deleteAccount,
  type CredentialKind,
} from "../db/repos/accounts";

export const providerAccountsRoutes = new Elysia({ prefix: "/console/api" })
  .get("/providers/:id/accounts", ({ params, query, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const version = accountsVersion(params.id);
    if (query.since === version) return { unchanged: true, version };
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const page = listAccountsPage(params.id, Number.isFinite(limit) ? limit : 50, query.cursor);
    if (params.id === "qoder" || params.id === "google-antigravity") {
      for (const account of page.items) {
        if (account.active && (!account.quota || account.quota.windows.length === 0)) void tokenKeeper.refreshAccountQuota(account.id);
      }
    }
    return { items: page.items, nextCursor: page.nextCursor, version: page.version };
  })
  /**
   * Reveals one account's credential so the console can offer a copy action.
   * Deliberately a separate endpoint from the account list: the list is polled
   * on every provider page render, and the secret should only cross the wire
   * when the operator explicitly asks for it. Access is already gated by the
   * console session guard, and the read is audited.
   */
  .get("/providers/:id/accounts/:accountId/credential", ({ params, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const account = getAccount(params.accountId);
    if (!account || account.provider !== params.id) {
      set.status = 404;
      return consoleError("not_found", "account not found");
    }
    if (account.credential_kind === "oauth") {
      set.status = 403;
      return consoleError("forbidden", "OAuth credentials cannot be revealed from the console.");
    }
    addAuditEvent("provider.account.credential_revealed", { provider: params.id, id: account.id, name: account.name });
    return { credential: account.credential };
  })
  .post("/providers/:id/accounts/import", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", `Unknown provider: ${params.id}`);
    }
    if (body.text.length > 1_000_000) {
      set.status = 413;
      return consoleError("invalid_request", "Import text exceeds the 1 MB limit");
    }
    try {
      const summary = await importAccountsForProvider(params.id, body.text);
      addAuditEvent("provider.account.imported", { provider: params.id, imported: summary.imported, skipped: summary.skipped.length, renamed: summary.renamed.length });
      return summary;
    } catch (error) {
      set.status = 400;
      return consoleError("invalid_request", error instanceof Error ? error.message : "Account import failed");
    }
  }, {
    body: t.Object({ text: t.String() }),
  })
  .post("/providers/:id/accounts", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const input = (body ?? {}) as {
      name?: string;
      credentialKind?: string;
      credential?: string;
      priority?: number;
      active?: boolean;
    };
    if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
      set.status = 400;
      return consoleError("invalid_request", "name is required");
    }
    if (!input.credential || typeof input.credential !== "string") {
      set.status = 400;
      return consoleError("invalid_request", "credential is required");
    }
    const expectedKind = accountCredentialKindOf(params.id);
    let credential = input.credential;
    if (expectedKind === "oauth") {
      if (params.id !== "openai-codex" && params.id !== "anthropic-oauth" && params.id !== "cline" && params.id !== "grok-cli" && params.id !== "google-antigravity") {
        set.status = 400;
        return consoleError("invalid_request", "unsupported OAuth provider import");
      }
      const imported = importOAuthCredential(params.id as OAuthImportProvider, input.credential);
      if (!imported.ok) {
        set.status = 400;
        return consoleError("invalid_request", imported.reason);
      }
      credential = imported.credential;
    }
    const credentialKind = (input.credentialKind ?? expectedKind) as CredentialKind;
    if (credentialKind !== expectedKind) {
      set.status = 400;
      return consoleError("invalid_request", `provider ${params.id} expects credential kind '${expectedKind}'`);
    }
    try {
      const created = await createAccount({
        provider: params.id,
        name: input.name.trim(),
        credentialKind,
        credential,
        priority: input.priority,
        active: input.active,
      });
      addAuditEvent("provider.account.created", { provider: params.id, id: created.id, name: input.name.trim() });
      if (params.id === "qoder") void tokenKeeper.refreshAccountQuota(created.id);
      set.status = 201;
      return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        set.status = 409;
        return consoleError("conflict", "an account with this name already exists for this provider");
      }
      set.status = 500;
      return consoleError("internal", message);
    }
  })
  .post("/providers/:id/accounts/:accountId", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const account = getAccount(params.accountId);
    if (!account || account.provider !== params.id) {
      set.status = 404;
      return consoleError("not_found", "account not found");
    }
    const input = (body ?? {}) as {
      name?: string;
      credential?: string;
      priority?: number;
      active?: boolean;
    };
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.trim().length === 0)) {
      set.status = 400;
      return consoleError("invalid_request", "name must be a non-empty string");
    }
    if (input.priority !== undefined && (!Number.isFinite(input.priority) || input.priority < 0 || input.priority > 1000)) {
      set.status = 400;
      return consoleError("invalid_request", "priority must be between 0 and 1000");
    }
    if (account.credential_kind === "oauth" && input.credential !== undefined) {
      set.status = 400;
      return consoleError("invalid_request", "OAuth credentials are managed by TokenKeeper");
    }
    try {
      await patchAccount(params.accountId, {
        name: input.name?.trim(),
        credential: input.credential,
        priority: input.priority,
        active: input.active,
      });
      addAuditEvent("provider.account.patched", { provider: params.id, id: params.accountId });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        set.status = 409;
        return consoleError("conflict", "an account with this name already exists for this provider");
      }
      set.status = 500;
      return consoleError("internal", message);
    }
  })
  .post("/providers/:id/accounts/:accountId/revoke", ({ params, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const account = getAccount(params.accountId);
    if (!account || account.provider !== params.id) {
      set.status = 404;
      return consoleError("not_found", "account not found");
    }
    if (account.credential_kind !== "oauth") {
      set.status = 400;
      return consoleError("invalid_request", "only OAuth accounts can be revoked here");
    }
    tokenKeeper.revokeCredential(account.id);
    addAuditEvent("provider.account.revoked", { provider: params.id, id: account.id, name: account.name });
    return { ok: true };
  })
  .delete("/providers/:id/accounts/:accountId", ({ params, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const account = getAccount(params.accountId);
    if (!account || account.provider !== params.id) {
      set.status = 404;
      return consoleError("not_found", "account not found");
    }
    if (account.credential_kind === "oauth") tokenKeeper.deleteCredential(params.accountId);
    else deleteAccount(params.accountId);
    addAuditEvent("provider.account.deleted", { provider: params.id, id: params.accountId, name: account.name });
    return { ok: true };
  });
