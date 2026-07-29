/**
 * Filter Rules API (console label; backed by `sanitizer_rules`, REQ-9) —
 * CRUD for the outbound-text sanitizer. See
 * `console/db/repos/sanitizer-rules.ts` for why the table isn't named
 * `filter_rules` (that name is already taken by an unrelated concept).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { invalidateRuntimeSettings } from "../runtime";
import {
  createSanitizerRule,
  deleteSanitizerRule,
  getSanitizerRuleById,
  InvalidPatternError,
  listSanitizerRules,
  updateSanitizerRule,
} from "../db/repos/sanitizer-rules";

interface RuleInput {
  ruleId?: string;
  pattern?: string;
  replacement?: string;
  isActive?: boolean;
  isRegex?: boolean;
  sortOrder?: number;
}

export const sanitizerRulesRoutes = new Elysia({ prefix: "/console/api/sanitizer-rules" })
  .get("/", () => ({ items: listSanitizerRules() }))
  .post("/", ({ body, set }) => {
    const input = (body ?? {}) as RuleInput;
    if (!input.ruleId?.trim() || !input.pattern) {
      set.status = 400;
      return consoleError("invalid_request", "ruleId and pattern are required");
    }
    try {
      const rule = createSanitizerRule({
        ruleId: input.ruleId.trim(),
        pattern: input.pattern,
        replacement: input.replacement,
        isActive: input.isActive,
        isRegex: input.isRegex,
        sortOrder: input.sortOrder,
      });
      invalidateRuntimeSettings();
      addAuditEvent("sanitizer_rule.create", { id: rule.id, ruleId: rule.ruleId });
      set.status = 201;
      return rule;
    } catch (err) {
      if (err instanceof InvalidPatternError) {
        set.status = 400;
        return consoleError("invalid_request", err.message);
      }
      set.status = 409;
      return consoleError("conflict", "a rule with this ruleId already exists");
    }
  })
  .post("/:id", ({ params, body, set }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      set.status = 400;
      return consoleError("invalid_request", "invalid rule id");
    }
    const input = (body ?? {}) as RuleInput;
    try {
      const updated = updateSanitizerRule(id, {
        pattern: input.pattern,
        replacement: input.replacement,
        isActive: input.isActive,
        isRegex: input.isRegex,
        sortOrder: input.sortOrder,
      });
      if (!updated) {
        set.status = 404;
        return consoleError("not_found", "rule not found");
      }
      invalidateRuntimeSettings();
      addAuditEvent("sanitizer_rule.update", { id });
      return updated;
    } catch (err) {
      if (err instanceof InvalidPatternError) {
        set.status = 400;
        return consoleError("invalid_request", err.message);
      }
      throw err;
    }
  })
  .delete("/:id", ({ params, set }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id) || !getSanitizerRuleById(id)) {
      set.status = 404;
      return consoleError("not_found", "rule not found");
    }
    deleteSanitizerRule(id);
    invalidateRuntimeSettings();
    addAuditEvent("sanitizer_rule.delete", { id });
    return { ok: true };
  });
