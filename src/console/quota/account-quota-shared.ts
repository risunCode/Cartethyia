import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditRecorder } from "../auth/service";
import { markClineApiKeyCredential } from "../../providers/integrations/cline/cline-quota";
import type { QuotaRefreshDeps } from "./quota-refresh";

/**
 * Dependencies shared by the tenant-scoped and global-admin account/quota route
 * groups. Both groups are composed onto one Elysia instance by
 * `createAccountQuotaRoutes`.
 */
export interface AccountQuotaRoutesDeps extends QuotaRefreshDeps {
  readonly accessResolver: ConsoleAccessResolver;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /** Records privileged account mutations (e.g. hard deletion) to `admin_audit_log`. */
  readonly auditRecorder?: AuditRecorder | undefined;
}

export const ACCOUNT_STATUSES = ["active", "cooldown", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Builds the refresh dependency bundle from the route deps, binding the
 * provider-specific credential normalisation (`cline` API keys) once so every
 * caller refreshes through the same wiring.
 */
export function createQuotaRefreshDeps(deps: AccountQuotaRoutesDeps): QuotaRefreshDeps {
  return {
    db: deps.db,
    redis: deps.redis,
    providerRegistry: deps.providerRegistry,
    resolveCredential: deps.resolveCredential,
    markApiKeyCredential: (providerId, credential) =>
      providerId === "cline" ? markClineApiKeyCredential(credential) : credential,
  };
}
