import type { RouteHealth } from "../../application/contracts";
import type { CredentialKind } from "../../application/contracts";
import type { QuotaSnapshotState } from "../../application/auth/credentials";

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface AccountQuotaWindowView {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
}

export interface AccountQuotaView {
  readonly source: string;
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly plan: string | null;
  readonly windows: readonly AccountQuotaWindowView[];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
}

export function quotaViewFromState(state: QuotaSnapshotState | null | undefined, nowAttemptAt: string | null = null): AccountQuotaView | null {
  if (state === null || state === undefined) return null;
  return { ...state, lastAttemptAt: state.lastAttemptAt ?? nowAttemptAt };
}

/** Account row with its bounded health snapshot and quota view (repo join). */
export interface AccountRowView {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly credentialKind: CredentialKind;
  readonly credentialHint: string;
  readonly priority: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly health: RouteHealth | null;
  readonly quota: AccountQuotaView | null;
}

export interface AccountCreateInput {
  readonly providerId: string;
  readonly name: string;
  readonly credentialKind: CredentialKind;
  readonly credential: string;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface AccountUpdateInput {
  readonly name?: string;
  readonly credentialKind?: CredentialKind;
  readonly credential?: string;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface ActiveAccountCredential {
  readonly credential: string;
  readonly credentialKind: CredentialKind;
}

/**
 * Keyset pagination for the console accounts endpoint. `cursor` is the last
 * account id of the previous page; results resume with `WHERE id > cursor`.
 * When omitted, `list` returns the full provider set (routing/summary callers).
 */
export interface AccountListOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Paged account list result for the console accounts endpoint. */
export interface AccountListResult {
  readonly items: readonly AccountRowView[];
  readonly nextCursor: string | null;
}

export interface AccountRepository {
  list(providerId?: string): Promise<readonly AccountRowView[]>;
  /** Keyset-paged listing for the console accounts endpoint. */
  listPaged(providerId: string, options: AccountListOptions): Promise<AccountListResult>;
  get(id: string): Promise<AccountRowView | null>;
  create(input: AccountCreateInput): Promise<{ readonly id: string; readonly credentialHint: string }>;
  update(id: string, patch: AccountUpdateInput): Promise<AccountRowView | null>;
  remove(id: string): Promise<boolean>;
  /** Batch delete by IDs — returns count of deleted rows. */
  removeBatch(ids: readonly string[]): Promise<number>;
  /** Batch set active flag — returns count of updated rows. */
  setActiveBatch(ids: readonly string[], active: boolean): Promise<number>;
  /** Explicit credential endpoint contract. */
  credential(id: string): Promise<{ readonly credential: string } | null>;
  /** Active credentials with their kind, for server-side model discovery. */
  listActiveCredentials(providerId: string): Promise<readonly ActiveAccountCredential[]>;
  health(accountId: string): Promise<RouteHealth | null>;
  quota(accountId: string): Promise<AccountQuotaView | null>;
}

