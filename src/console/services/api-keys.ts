import type { ApiKeyRepository, ApiKeySecretResult, ApiKeyView, ConsoleErrorCode } from "../views";
import { isValidCustomApiKey, limitOrUndefined, sanitizeKeyUpdate, stringListOrUndefined, stringOrUndefined } from "../input-sanitizers";
export class ApiKeyService {
  constructor(private readonly repo: ApiKeyRepository) {}

  async list(): Promise<readonly ApiKeyView[]> {
    return this.repo.list();
  }

  async create(input: unknown): Promise<ApiKeySecretResult | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "key name is required" };
    }
    const customKey = stringOrUndefined(value.key);
    if (customKey !== undefined && !isValidCustomApiKey(customKey)) {
      return { ok: false, status: 400, code: "invalid_request", message: "custom API key must be 8-256 letters, digits, underscores, or hyphens" };
    }
    const result = await this.repo.create({
      name: value.name.trim(),
      key: customKey,
      prefix: stringOrUndefined(value.prefix),
      rateLimitRpm: limitOrUndefined(value.rateLimitRpm),
      dailyTokenLimit: limitOrUndefined(value.dailyTokenLimit),
      monthlyTokenLimit: limitOrUndefined(value.monthlyTokenLimit),
      oneTimeTokenLimit: limitOrUndefined(value.oneTimeTokenLimit),
      maxConcurrentRequests: limitOrUndefined(value.maxConcurrentRequests),
      providerAllowlist: stringListOrUndefined(value.providerAllowlist),
      modelAllowlist: stringListOrUndefined(value.modelAllowlist),
      modelDenylist: stringListOrUndefined(value.modelDenylist),
    });
    if ("error" in result) {
      return { ok: false, status: 409, code: "conflict", message: "a key with this name already exists" };
    }
    return result;
  }

  async update(id: string, patch: unknown): Promise<ApiKeyView | null> {
    if (typeof patch !== "object" || patch === null) return null;
    return this.repo.update(id, sanitizeKeyUpdate(patch as Record<string, unknown>));
  }

  async regenerate(id: string): Promise<ApiKeySecretResult | null> {
    return this.repo.regenerate(id);
  }

  async revoke(id: string): Promise<boolean> {
    return this.repo.revoke(id);
  }

  async remove(id: string): Promise<boolean> {
    return this.repo.remove(id);
  }

  async credential(id: string): Promise<{ readonly key: string } | null> {
    return this.repo.credential(id);
  }
}
