/**
 * Combos/aliases/filters API — CRUD + resolve preview (REQ-21, design §5.6).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import {
  listAliases,
  upsertAlias,
  deleteAlias,
  resolveAlias,
  listCombos,
  createCombo,
  updateCombo,
  deleteCombo,
  getComboByName,
  listFilters,
  createFilter,
  updateFilter,
  deleteFilter,
  evaluateFilter,
  type FilterMode,
} from "../db/repos/combos";
import { parseQualifiedModel } from "../../routing/resolve";
import { providerRegistry } from "../../upstream/providers";
import type { AddedProviderId } from "../../routing/types";
import { isProviderId } from "../../routing/providerMeta";
import { isRotationStrategy } from "../../routing/strategy";

/** Parse "prefix/model" via the shared routing parser, discarding invalid-reason detail. */
function parseQualified(model: string): { provider: AddedProviderId; modelId: string } | null {
  const result = parseQualifiedModel(model);
  return result.kind === "qualified" ? result.model : null;
}

export const combosRoutes = new Elysia({ prefix: "/console/api" })
  // ── Aliases ────────────────────────────────────────────────────
  .get("/aliases", () => ({ items: listAliases() }))
  .post("/aliases", ({ body, set }) => {
    const input = (body ?? {}) as { alias?: string; model?: string };
    if (!input.alias?.trim() || !input.model?.trim()) {
      set.status = 400;
      return consoleError("invalid_request", "alias and model are required");
    }
    if (!parseQualified(input.model.trim()) && !getComboByName(input.model.trim())) {
      set.status = 400;
      return consoleError("invalid_request", "model must be a qualified prefix/model or an existing combo name");
    }
    upsertAlias(input.alias.trim(), input.model.trim());
    addAuditEvent("alias.upsert", { alias: input.alias.trim(), model: input.model.trim() });
    return { ok: true };
  })
  .delete("/aliases/:alias", ({ params, set }) => {
    const removed = deleteAlias(decodeURIComponent(params.alias));
    if (!removed) {
      set.status = 404;
      return consoleError("not_found", "alias not found");
    }
    addAuditEvent("alias.delete", { alias: params.alias });
    return { ok: true };
  })
  // ── Combos ─────────────────────────────────────────────────────
  .get("/combos", () => ({ items: listCombos() }))
  .post("/combos", ({ body, set }) => {
    const input = (body ?? {}) as { name?: string; models?: string[]; strategy?: string; stickyLimit?: number };
    if (!input.name?.trim()) {
      set.status = 400;
      return consoleError("invalid_request", "name is required");
    }
    if (!Array.isArray(input.models) || input.models.length < 2) {
      set.status = 400;
      return consoleError("invalid_request", "models must contain at least 2 qualified model ids");
    }
    for (const model of input.models) {
      if (!parseQualified(model)) {
        set.status = 400;
        return consoleError("invalid_request", `"${model}" is not a valid prefix/model`);
      }
    }
    const strategy = isRotationStrategy(input.strategy) ? input.strategy : "fallback";
    const stickyLimit = Number.isFinite(input.stickyLimit) ? Math.max(0, Math.floor(input.stickyLimit as number)) : 0;
    try {
      const combo = createCombo({ name: input.name.trim(), models: input.models, strategy, stickyLimit });
      addAuditEvent("combo.create", { id: combo.id, name: combo.name });
      set.status = 201;
      return combo;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set.status = message.includes("UNIQUE") ? 409 : 500;
      return consoleError(message.includes("UNIQUE") ? "conflict" : "internal", message.includes("UNIQUE") ? "a combo with this name already exists" : message);
    }
  })
  .post("/combos/:id", ({ params, body, set }) => {
    const input = (body ?? {}) as { name?: string; models?: string[]; strategy?: string; stickyLimit?: number };
    if (input.models !== undefined) {
      if (!Array.isArray(input.models) || input.models.length < 2) {
        set.status = 400;
        return consoleError("invalid_request", "models must contain at least 2 qualified model ids");
      }
      for (const model of input.models) {
        if (!parseQualified(model)) {
          set.status = 400;
          return consoleError("invalid_request", `"${model}" is not a valid prefix/model`);
        }
      }
    }
    const updated = updateCombo(params.id, {
      name: input.name?.trim(),
      models: input.models,
      strategy: isRotationStrategy(input.strategy) ? input.strategy : undefined,
      stickyLimit: Number.isFinite(input.stickyLimit) ? Math.max(0, Math.floor(input.stickyLimit as number)) : undefined,
    });
    if (!updated) {
      set.status = 404;
      return consoleError("not_found", "combo not found");
    }
    addAuditEvent("combo.update", { id: params.id });
    return { ok: true };
  })
  .delete("/combos/:id", ({ params, set }) => {
    const removed = deleteCombo(params.id);
    if (!removed) {
      set.status = 404;
      return consoleError("not_found", "combo not found");
    }
    addAuditEvent("combo.delete", { id: params.id });
    return { ok: true };
  })
  // ── Filters ────────────────────────────────────────────────────
  .get("/filters", ({ query }) => ({ items: listFilters(query?.provider) }))
  .post("/filters", ({ body, set }) => {
    const input = (body ?? {}) as { provider?: string; mode?: string; patterns?: string[] };
    if (!input.provider || !isProviderId(input.provider)) {
      set.status = 400;
      return consoleError("invalid_request", "provider must be a known provider id");
    }
    if (input.mode !== "allow" && input.mode !== "deny") {
      set.status = 400;
      return consoleError("invalid_request", "mode must be 'allow' or 'deny'");
    }
    if (!Array.isArray(input.patterns) || input.patterns.length === 0) {
      set.status = 400;
      return consoleError("invalid_request", "patterns must be a non-empty array");
    }
    const filter = createFilter(input.provider, input.mode as FilterMode, input.patterns);
    addAuditEvent("filter.create", { id: filter.id, provider: filter.provider, mode: filter.mode });
    set.status = 201;
    return filter;
  })
  .post("/filters/:id", ({ params, body, set }) => {
    const input = (body ?? {}) as { provider?: string; mode?: string; patterns?: string[] };
    if (input.provider !== undefined && !isProviderId(input.provider)) {
      set.status = 400;
      return consoleError("invalid_request", "provider must be a known provider id");
    }
    if (input.mode !== undefined && input.mode !== "allow" && input.mode !== "deny") {
      set.status = 400;
      return consoleError("invalid_request", "mode must be 'allow' or 'deny'");
    }
    const updated = updateFilter(params.id, {
      provider: input.provider,
      mode: input.mode as FilterMode | undefined,
      patterns: input.patterns,
    });
    if (!updated) {
      set.status = 404;
      return consoleError("not_found", "filter not found");
    }
    addAuditEvent("filter.update", { id: params.id });
    return { ok: true };
  })
  .delete("/filters/:id", ({ params, set }) => {
    const removed = deleteFilter(params.id);
    if (!removed) {
      set.status = 404;
      return consoleError("not_found", "filter not found");
    }
    addAuditEvent("filter.delete", { id: params.id });
    return { ok: true };
  })
  // ── Resolve preview ────────────────────────────────────────────
  .post("/resolve-preview", ({ body, set }) => {
    const { model } = (body ?? {}) as { model?: string };
    if (!model?.trim()) {
      set.status = 400;
      return consoleError("invalid_request", "model is required");
    }
    const trace: string[] = [`input: ${model}`];
    let current = model.trim();

    // 1. Qualified prefix
    let qualified = parseQualified(current);
    if (qualified) {
      trace.push(`qualified prefix → ${qualified.provider}/${qualified.modelId}`);
    } else {
      // 2. Alias
      const aliasTarget = resolveAlias(current);
      if (aliasTarget) {
        trace.push(`alias "${current}" → "${aliasTarget}"`);
        current = aliasTarget;
        qualified = parseQualified(current);
      }
    }

    // 3. Combo (either the original input or the alias target names a combo)
    const combo = !qualified ? getComboByName(current) : null;
    if (combo) {
      trace.push(`combo "${combo.name}" → [${combo.models.join(", ")}] (${combo.strategy})`);
      const candidates = combo.models.map((m) => {
        const q = parseQualified(m);
        if (!q) return { model: m, provider: null, modelId: null, filter: { result: "denied" as const, reason: "invalid model in combo" } };
        const provider = providerRegistry.get(q.provider);
        const modelExists = provider ? Boolean(provider.models.resolve(q.modelId)) : false;
        const filter = evaluateFilter(q.provider, q.modelId);
        return {
          model: m,
          provider: q.provider,
          modelId: q.modelId,
          modelExists,
          filter,
        };
      });
      return { ok: true, trace, resolved: { kind: "combo", strategy: combo.strategy, candidates } };
    }

    if (!qualified) {
      trace.push("no qualified prefix, alias, or combo matched");
      set.status = 404;
      return { ok: false, trace, error: "could not resolve model" };
    }

    const provider = providerRegistry.get(qualified.provider);
    const modelExists = provider ? Boolean(provider.models.resolve(qualified.modelId)) : false;
    if (!modelExists) trace.push(`model "${qualified.modelId}" not found in ${qualified.provider} catalog`);
    const filter = evaluateFilter(qualified.provider, qualified.modelId);
    trace.push(`filter check → ${filter.result}${filter.reason ? ` (${filter.reason})` : ""}`);

    return {
      ok: modelExists && filter.result === "allowed",
      trace,
      resolved: { kind: "single", provider: qualified.provider, modelId: qualified.modelId, modelExists, filter },
    };
  });
