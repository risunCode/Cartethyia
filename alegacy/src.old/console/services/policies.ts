import type { ModelMetadataResolver } from "../../application/model-metadata";
import type { AliasView, ComboView, ConsoleErrorCode, FilterRuleRepository, FilterRuleView, RoutingConfigRepository } from "../views";

export class FilterRuleService {
  private cache: { rules: readonly FilterRuleView[]; at: number } | null = null;
  private static readonly CACHE_TTL_MS = 5_000;

  constructor(private readonly repo: FilterRuleRepository) {}

  private async getCachedRules(): Promise<readonly FilterRuleView[]> {
    if (this.cache !== null && Date.now() - this.cache.at < FilterRuleService.CACHE_TTL_MS) {
      return this.cache.rules;
    }
    const rules = await this.repo.list();
    this.cache = { rules, at: Date.now() };
    return rules;
  }

  private invalidate(): void { this.cache = null; }

  async list(): Promise<{ readonly count: number; readonly activeCount: number; readonly rules: readonly FilterRuleView[] }> {
    const rules = await this.getCachedRules();
    return { count: rules.length, activeCount: rules.filter((r) => r.isActive).length, rules };
  }

  async create(input: unknown): Promise<FilterRuleView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    const value = input as Record<string, unknown>;
    if (typeof value.pattern !== "string" || value.pattern.trim().length === 0) return { ok: false, status: 400, code: "invalid_request", message: "pattern is required" };
    const isRegex = value.isRegex !== false;
    if (isRegex) { try { new RegExp(value.pattern, "gi"); } catch { return { ok: false, status: 400, code: "invalid_request", message: "invalid regex pattern" }; } }
    try {
      const result = await this.repo.create({
        ruleId: typeof value.ruleId === "string" && value.ruleId.trim().length > 0 ? value.ruleId.trim() : undefined,
        pattern: value.pattern.trim(),
        replacement: typeof value.replacement === "string" ? value.replacement : "",
        isRegex,
        isActive: value.isActive !== false,
      });
      this.invalidate();
      return result;
    } catch (error) {
      return { ok: false, status: 400, code: "invalid_request", message: error instanceof Error ? error.message : "create failed" };
    }
  }

  async update(id: number, input: unknown): Promise<FilterRuleView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    const value = input as Record<string, unknown>;
    const patch: { pattern?: string; replacement?: string; isRegex?: boolean; isActive?: boolean; sortOrder?: number } = {};
    if (typeof value.pattern === "string") patch.pattern = value.pattern.trim();
    if (typeof value.replacement === "string") patch.replacement = value.replacement;
    if (typeof value.isRegex === "boolean") patch.isRegex = value.isRegex;
    if (typeof value.isActive === "boolean") patch.isActive = value.isActive;
    if (typeof value.sortOrder === "number") patch.sortOrder = value.sortOrder;
    if (patch.isRegex === true && patch.pattern !== undefined) { try { new RegExp(patch.pattern, "gi"); } catch { return { ok: false, status: 400, code: "invalid_request", message: "invalid regex pattern" }; } }
    try {
      const result = await this.repo.update(id, patch);
      if (result === null) return { ok: false, status: 404, code: "not_found", message: "filter rule not found" };
      this.invalidate();
      return result;
    } catch (error) {
      return { ok: false, status: 400, code: "invalid_request", message: error instanceof Error ? error.message : "update failed" };
    }
  }

  async remove(id: number): Promise<boolean> {
    const result = await this.repo.remove(id);
    if (result) this.invalidate();
    return result;
  }
}

export class RoutingConfigService {
  constructor(
    private readonly repo: RoutingConfigRepository,
    private readonly modelMetadata?: ModelMetadataResolver,
  ) {}

  async listAliases(): Promise<readonly AliasView[]> {
    const rows = await this.repo.listAliases();
    if (this.modelMetadata === undefined) return rows;
    return Promise.all(rows.map(async (row) => ({ ...row, metadata: (await this.modelMetadata!.resolve(row.model)) ?? undefined })));
  }

  async createAlias(input: unknown): Promise<AliasView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.alias !== "string" || value.alias.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "alias is required" };
    }
    if (typeof value.model !== "string" || value.model.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "model is required" };
    }
    const result = await this.repo.putAlias(value.alias.trim(), value.model.trim());
    return result;
  }

  async deleteAlias(alias: string): Promise<boolean> {
    return this.repo.deleteAlias(alias);
  }

  async listCombos(): Promise<readonly ComboView[]> {
    const rows = await this.repo.listCombos();
    if (this.modelMetadata === undefined) return rows;
    return Promise.all(rows.map(async (row) => ({ ...row, metadata: (await this.modelMetadata!.resolve(row.name)) ?? undefined })));
  }

  async putCombo(input: unknown, id?: string): Promise<ComboView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "combo name is required" };
    }
    if (!Array.isArray(value.models) || value.models.length === 0 || !value.models.every((item) => typeof item === "string" && item.length > 0)) {
      return { ok: false, status: 400, code: "invalid_request", message: "combo must list at least one model" };
    }
    const strategy = value.strategy === "round-robin" ? "round-robin" : "fallback";
    const stickyLimit = typeof value.stickyLimit === "number" && Number.isFinite(value.stickyLimit) ? Math.max(0, Math.floor(value.stickyLimit)) : 0;
    const existing = id === undefined ? null : await this.repo.getCombo(id);
    const name = id === undefined || existing === null || existing.name === value.name ? value.name.trim() : value.name.trim();
    return this.repo.putCombo({ name, models: value.models as readonly string[], strategy, stickyLimit });
  }

  async deleteCombo(id: string): Promise<boolean> {
    return this.repo.deleteCombo(id);
  }
}