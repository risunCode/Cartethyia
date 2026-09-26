/**
 * Provider and account operations for the provider console domain: tenant and
 * global provider CRUD, account lifecycle, account health events, and the
 * decrypted account export.
 *
 * Split out of `routes.ts` so the provider/account operations and the model
 * operations (`model-operations.ts`) each stay a readable unit. Every operation
 * validates access through `requireTenantScope`/`requireGlobalAdmin` first and
 * returns DTOs from `./contracts`; the Elysia wiring for these handlers lives in
 * `routes.ts`.
 */
import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
import {
  ConsoleDomainError,
  requireGlobalAdmin,
  requireTenantAnyScope,
} from "../../shared/errors";
import type { AccessDecision } from "../../../security/access-control";
import { isBundledProviderId, type ProviderRegistry } from "../../../providers/provider-registry";
import type { CompatibilityProfile } from "../../../providers/provider-metadata";
import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import { PROVIDER_READ_SCOPES, PROVIDER_WRITE_SCOPES } from "./contracts";
import {
  isWireFamily,
  validateCompatibilityProfile,
  type CreateProviderAccountRequest,
  type CreateProviderRequest,
  type ProviderAccountExport,
  type ProviderAccountsExportResponse,
  type ProviderAccountResponse,
  type ProviderCatalogStore,
  type ProviderRecord,
  type ProviderResponse,
  type UpdateProviderAccountRequest,
  type UpdateProviderRequest,
} from "./contracts";
export function sanitizeProviderResponse(
  provider: unknown,
  includeSecrets = false,
): ProviderResponse {
  if (!provider || typeof provider !== "object")
    throw new ConsoleDomainError("invalid_provider", 400, "Provider must be an object");
  const p = provider as Record<string, unknown>;
  if (typeof p.providerId !== "string" || p.providerId.length === 0)
    throw new ConsoleDomainError("invalid_provider", 400, "Provider providerId is required");
  for (const field of ["enabled", "isBuiltIn", "requiresAccount"] as const) {
    if (p[field] !== undefined && typeof p[field] !== "boolean")
      throw new ConsoleDomainError("invalid_provider", 400, `Provider ${field} must be a boolean`);
  }
  const response: ProviderResponse = {
    providerId: p.providerId,
    ...(typeof p.label === "string" && p.label.length > 0 ? { label: p.label } : {}),
    enabled: (p.enabled as boolean | undefined) ?? true,
    isBuiltIn: (p.isBuiltIn as boolean | undefined) ?? false,
    requiresAccount: (p.requiresAccount as boolean | undefined) ?? true,
    supportsModelDiscovery: (p.supportsModelDiscovery as boolean | undefined) ?? !p.isBuiltIn,
    ...(typeof p.createdAt === "string" ? { createdAt: p.createdAt } : {}),
    ...(typeof p.updatedAt === "string" ? { updatedAt: p.updatedAt } : {}),
  };
  if (includeSecrets && p.capabilityProfile)
    response.capabilityProfile = p.capabilityProfile as Record<string, unknown>;
  if (includeSecrets && typeof p.baseUrl === "string") response.baseUrl = p.baseUrl;
  if (includeSecrets && p.compatibilityProfile)
    response.compatibilityProfile = p.compatibilityProfile as CompatibilityProfile;
  if (isWireFamily(p.wireFamilyDefault)) response.wireFamilyDefault = p.wireFamilyDefault;
  // Derived policy, not a secret: always projected. Entries are re-validated so
  // a malformed record narrows to the families the vocabulary admits instead of
  // emitting a value dispatch would reject.
  if (Array.isArray(p.supportedWireFamilies)) {
    const families = p.supportedWireFamilies.filter(isWireFamily);
    if (families.length > 0) response.supportedWireFamilies = families;
  }
  return response;
}


export interface ProviderCatalogConfig {
  readonly store: ProviderCatalogStore;
  readonly accessResolver: ConsoleAccessResolver;
  /** Records privileged mutations to `admin_audit_log`; a no-op when omitted (e.g. tests). */
  readonly auditSink?: AuditSink;
  /** Registry-backed OAuth login clients; used to compute `oauthFlows` on responses. */
  readonly providerRegistry: ProviderRegistry;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /**
   * Re-applies one provider's BYOK adapter registration after a create/update
   * so a custom provider is dispatchable without a restart. Optional: tests
   * and read-only hosts omit it and keep boot-time registrations only.
   */
  readonly syncByokProvider?: (providerId: string) => Promise<unknown>;
  /**
   * Operator-defined routing targets shown alongside `models` rows in the
   * flat picker catalog. Optional so hosts without a routing store (and
   * existing test doubles) keep returning model entries only.
   */
  readonly listRoutingTargets?: (tenantId: string) => Promise<{
    readonly aliases: readonly { readonly alias: string; readonly targetModel: string }[];
    readonly combos: readonly {
      readonly name: string;
      readonly members: readonly string[];
    }[];
  }>;
  /**
   * Resolves a stored credential through the refresh-aware path, returning the
   * plaintext secret. Only the account-export operation consumes it; when
   * omitted, export returns `""` for every secret rather than failing.
   */
  readonly resolveCredential?: (providerId: string, accountId: string) => Promise<string>;
}
async function attachProviderCapabilities(
  response: ProviderResponse,
  registry: ProviderRegistry,
): Promise<ProviderResponse> {
  const supportsDiscovery =
    !response.isBuiltIn || (await registry.resolveModelDiscovery(response.providerId)) !== undefined;
  const client = await registry.resolveLoginClient(response.providerId);
  if (!client) return { ...response, supportsModelDiscovery: supportsDiscovery };
  // Capability is a static property of the client's methods, never of one URL
  // build: a client whose `buildAuthorizeUrl` can throw must still report the
  // browser flow it genuinely supports, otherwise the Login with browser button
  // disappears for a provider that has one.
  //
  // `supportsBrowserCode` is authoritative when the client states it. The base
  // `OAuthClient` always defines `buildAuthorizeUrl` and `exchangeCode` — the
  // device-only clients override the latter to throw — so testing only for the
  // methods reports browser support for every device-only provider (Cline,
  // Cursor, Grok, Kimi, Muse, Buddy). The dashboard then offered "Login with
  // browser" on those rows and the click failed server-side with
  // `browser_code_not_supported`. An explicit `false` suppresses the flow; an
  // omitted flag keeps the method-shape test, since a client that does not
  // state the capability is judged by what it can do.
  const hasBrowserFlow =
    client.supportsBrowserCode === false
      ? false
      : typeof client.buildAuthorizeUrl === "function" &&
        typeof client.exchangeCode === "function";
  return {
    ...response,
    supportsModelDiscovery: supportsDiscovery,
    oauthFlows: {
      browser: hasBrowserFlow,
      device: client.supportsDeviceCode === true && typeof client.startDeviceAuth === "function",
    },
  };
}
export function createProviderCatalogOperations(config: ProviderCatalogConfig) {
  const operations = {
    async listProviders(access: AccessDecision | undefined): Promise<ProviderResponse[]> {
      const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
      const [records, accounts] = await Promise.all([
        config.store.list(a.tenantId),
        config.store.listAllAccounts(a.tenantId),
      ]);
      const configured = new Set(accounts.map((account) => account.providerId));
      return Promise.all(
        records.map((r) =>
          attachProviderCapabilities(
            { ...sanitizeProviderResponse(r), configured: configured.has(r.providerId) },
            config.providerRegistry,
          ),
        ),
      );
    },
    async getProviderDetail(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<ProviderResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
        const rec = await config.store.get(a.tenantId, providerId);
        if (!rec)
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        return attachProviderCapabilities(sanitizeProviderResponse(rec, true), config.providerRegistry);
      },
    async createProvider(
        access: AccessDecision | undefined,
        request: CreateProviderRequest,
      ): Promise<ProviderResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.providerId.toLowerCase()))
          throw new ConsoleDomainError(
            "invalid_provider_id",
            400,
            "Provider ID must be a lowercase slug",
          );
        if (isBundledProviderId(request.providerId))
          throw new ConsoleDomainError("slug_reserved", 409, "Provider ID is reserved", {
            providerId: request.providerId,
          });
        if (request.compatibilityProfile !== undefined) {
          try {
            validateCompatibilityProfile(request.compatibilityProfile);
          } catch (error) {
            throw new ConsoleDomainError(
              "invalid_compatibility_profile",
              400,
              error instanceof Error ? error.message : "Invalid compatibility profile",
            );
          }
        }
        if (request.wireFamily !== undefined && !isWireFamily(request.wireFamily)) {
          throw new ConsoleDomainError(
            "invalid_wire_family",
            400,
            `wireFamily must be one of chat, responses, messages`,
          );
        }
        const record: ProviderRecord = {
          providerId: request.providerId,
          tenantId: a.tenantId,
          enabled: request.enabled ?? true,
          isBuiltIn: false,
          supportsModelDiscovery: true,
          // BYOK providers always need an operator-configured credential; only
          // the two builtin credential-less routes get `false`, set at seed time.
          requiresAccount: true,
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.capabilityProfile === undefined
            ? {}
            : { capabilityProfile: request.capabilityProfile }),
          ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
          // The operator's chosen wire family is what the BYOK adapter derives
          // its supported families and credential header shape from; dropping
          // it here silently made every custom provider an OpenAI-compatible one.
          ...(request.wireFamily === undefined || !isWireFamily(request.wireFamily)
            ? {}
            : { wireFamilyDefault: request.wireFamily }),
          ...(request.compatibilityProfile === undefined
            ? {}
            : { compatibilityProfile: request.compatibilityProfile }),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await config.store.create(record);
        if (request.models && request.models.length > 0) {
          await config.store.registerModels(
            a.tenantId,
            record.providerId,
            request.models,
            request.wireFamily,
          );
        }
        await config.auditSink?.record({
          access: a,
          action: "provider.created",
          target: record.providerId,
          detail: { wireFamily: request.wireFamily, modelCount: request.models?.length ?? 0 },
        });
        await config.snapshotInvalidator?.invalidate();
        await config.syncByokProvider?.(record.providerId);
        return attachProviderCapabilities(sanitizeProviderResponse(record, true), config.providerRegistry);
      },
    async updateProvider(
        access: AccessDecision | undefined,
        providerId: string,
        request: UpdateProviderRequest,
      ): Promise<ProviderResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        if (request.compatibilityProfile !== undefined) {
          try {
            validateCompatibilityProfile(request.compatibilityProfile);
          } catch (error) {
            throw new ConsoleDomainError(
              "invalid_compatibility_profile",
              400,
              error instanceof Error ? error.message : "Invalid compatibility profile",
            );
          }
        }
        const updated = await config.store.update(a.tenantId, providerId, request);
        if (!updated)
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        await config.auditSink?.record({
          access: a,
          action: "provider.updated",
          target: providerId,
          detail: { fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        await config.syncByokProvider?.(providerId);
        return attachProviderCapabilities(sanitizeProviderResponse(updated, true), config.providerRegistry);
      },
    async deleteProvider(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<{ success: boolean }> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const ok = await config.store.delete(a.tenantId, providerId);
        if (!ok)
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        await config.auditSink?.record({
          access: a,
          action: "provider.deleted",
          target: providerId,
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async updateGlobalProvider(
        access: AccessDecision | undefined,
        providerId: string,
        request: UpdateProviderRequest,
      ): Promise<ProviderResponse> {
        const a = requireGlobalAdmin(access);
        const updated = await config.store.updateGlobal(providerId, request);
        if (!updated) {
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        }
        await config.auditSink?.record({
          access: a,
          action: "provider.global.updated",
          target: providerId,
          detail: { fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        await config.syncByokProvider?.(providerId);
        return sanitizeProviderResponse(updated, true);
      },
    async deleteGlobalProvider(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<{ success: boolean }> {
        const a = requireGlobalAdmin(access);
        const deleted = await config.store.deleteGlobal(providerId);
        if (!deleted) {
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        }
        await config.auditSink?.record({
          access: a,
          action: "provider.global.deleted",
          target: providerId,
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async listAccounts(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<readonly ProviderAccountResponse[]> {
        const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
        return config.store.listAccounts(a.tenantId, providerId);
      },
    async createAccount(
        access: AccessDecision | undefined,
        providerId: string,
        request: CreateProviderAccountRequest,
      ): Promise<ProviderAccountResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        if (
          request.credentialKind !== "api_key" &&
          request.credentialKind !== "oauth" &&
          request.credentialKind !== "none"
        ) {
          throw new ConsoleDomainError(
            "invalid_request",
            400,
            "credentialKind must be api_key, oauth, or none",
          );
        }
        const created = await config.store.createAccount(
          a.tenantId,
          providerId,
          request,
        );
        await config.auditSink?.record({
          access: a,
          action: "provider_account.created",
          target: created.id,
          detail: { providerId, credentialKind: request.credentialKind },
        });
        await config.snapshotInvalidator?.invalidate();
        return created;
      },
    async updateAccount(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
        request: UpdateProviderAccountRequest,
      ): Promise<ProviderAccountResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const updated = await config.store.updateAccount(
          a.tenantId,
          providerId,
          accountId,
          request,
        );
        if (!updated)
          throw new ConsoleDomainError("account_not_found", 404, `Account ${accountId} not found`);
        await config.auditSink?.record({
          access: a,
          action:
            request.status === "disabled" ? "provider_account.revoked" : "provider_account.updated",
          target: accountId,
          detail: { providerId, fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        return updated;
      },
    async listAccountHealthEvents(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
      ): Promise<readonly AccountHealthEventRecord[]> {
        const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
        return config.store.listAccountHealthEvents(a.tenantId, providerId, accountId);
      },
    async recoverAccount(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
      ): Promise<{ success: boolean }> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const ok = await config.store.recoverAccount(a.tenantId, providerId, accountId);
        if (!ok)
          throw new ConsoleDomainError("account_not_found", 404, `Account ${accountId} not found`);
        await config.auditSink?.record({
          access: a,
          action: "provider_account.recovered",
          target: accountId,
          detail: { providerId },
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    /**
     * Exports the requested accounts with their decrypted credentials.
     *
     * Secret material leaves the process here, so the audit entry records the
     * account ids but never the returned values. `accountIds` is required and
     * scoped to the caller's tenant; ids that do not belong to the provider
     * (or the tenant) are silently skipped.
     *
     * Only tenant-owned accounts are eligible: `listAccounts` also returns
     * pool-wide global accounts (tenantId null), and a tenant must never be
     * able to decrypt another deployment's shared credentials.
     */
    async exportAccounts(
        access: AccessDecision | undefined,
        providerId: string,
        accountIds: readonly string[],
      ): Promise<ProviderAccountsExportResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const owned = await config.store.listAccounts(a.tenantId, providerId);
        const wanted = new Set(accountIds);
        const selected = owned.filter(
          (account) => wanted.has(account.id) && account.tenantId === a.tenantId,
        );
        const accounts = await Promise.all(
          selected.map(async (account): Promise<ProviderAccountExport> => {
            let secret = "";
            if (config.resolveCredential) {
              try {
                secret = await config.resolveCredential(providerId, account.id);
              } catch {
                // A refresh failure must not abort the whole export; the
                // account still exports its metadata with an empty secret.
                secret = "";
              }
            }
            return {
              id: account.id,
              providerId: account.providerId,
              label: account.label,
              credentialKind: account.credentialKind,
              status: account.status,
              secret,
              ...(account.inflight === undefined ? {} : { inflight: account.inflight }),
              createdAt: account.createdAt,
              ...(account.cooldownUntil ? { cooldownUntil: account.cooldownUntil } : {}),
              ...(account.lastErrorCategory
                ? { lastErrorCategory: account.lastErrorCategory }
                : {}),
            };
          }),
        );
        await config.auditSink?.record({
          access: a,
          action: "provider_account.exported",
          target: providerId,
          detail: { providerId, accountIds: accounts.map((account) => account.id) },
        });
        return { exportedAt: new Date().toISOString(), accounts };
      },
  };
  return operations;
}
