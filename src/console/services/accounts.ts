import type { AccountRepository, AccountListOptions, AccountListResult, AccountRowView, ConsoleErrorCode, RouteTransitionStore, RouteTransitionView } from "../views";
import { booleanOrUndefined, credentialKind, numberOrUndefined, stringOrUndefined } from "../input-sanitizers";
import { loadRouteTransition } from "../views";
import { normalizeApiKeyCredential } from "./providers";

/** Account row plus failed/replacement route switch metadata. */
export interface AccountView extends AccountRowView, RouteTransitionView {}


export class AccountService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly transitions: RouteTransitionStore,
  ) {}

  async list(providerId?: string): Promise<readonly AccountView[]> {
    const rows = await this.repo.list(providerId);
    return Promise.all(rows.map(async (row) => ({ ...row, ...(await loadRouteTransition("account", row.id, row.health, this.transitions)) })));
  }

  async listPaged(providerId: string, options: AccountListOptions): Promise<AccountListResult> {
    const page = await this.repo.listPaged(providerId, options);
    const items = await Promise.all(page.items.map(async (row) => ({ ...row, ...(await loadRouteTransition("account", row.id, row.health, this.transitions)) })));
    return { items, nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<AccountView | null> {
    const row = await this.repo.get(id);
    if (row === null) return null;
    return { ...row, ...(await loadRouteTransition("account", row.id, row.health, this.transitions)) };
  }

  async create(input: unknown): Promise<{ readonly id: string; readonly credentialHint: string } | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.providerId !== "string" || value.providerId.length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "provider is required" };
    }
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "account name is required" };
    }
    const kind = credentialKind(value.credentialKind);
    const credential = typeof value.credential === "string" ? kind === "api_key" ? normalizeApiKeyCredential(value.credential) : value.credential : "";
    if (credential.length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "credential is required" };
    }
    return this.repo.create({
      providerId: value.providerId,
      name: value.name.trim(),
      credentialKind: kind,
      credential,
      priority: numberOrUndefined(value.priority),
      active: booleanOrUndefined(value.active),
    });
  }

  async update(id: string, patch: unknown): Promise<AccountRowView | null> {
    if (typeof patch !== "object" || patch === null) return null;
    const value = patch as Record<string, unknown>;
    return this.repo.update(id, {
      credentialKind: credentialKind(value.credentialKind),
      name: stringOrUndefined(value.name),
      credential: typeof value.credential === "string" ? credentialKind(value.credentialKind) === "api_key" ? normalizeApiKeyCredential(value.credential) : value.credential : undefined,
      priority: numberOrUndefined(value.priority),
      active: booleanOrUndefined(value.active),
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.repo.remove(id);
  }

  async removeBatch(ids: readonly string[]): Promise<number> {
    return this.repo.removeBatch(ids);
  }

  async setActiveBatch(ids: readonly string[], active: boolean): Promise<number> {
    return this.repo.setActiveBatch(ids, active);
  }

  async credential(id: string): Promise<{ readonly credential: string } | null> {
    return this.repo.credential(id);
  }
}