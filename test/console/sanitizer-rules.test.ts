/** Sanitizer rules repo tests — CRUD, invalid-regex rejection, seed idempotency (REQ-9). */

import { beforeEach, describe, expect, test } from "bun:test";
import { useIsolatedDataDir } from "./helpers";
import {
  createSanitizerRule,
  deleteSanitizerRule,
  InvalidPatternError,
  listActiveSanitizerRules,
  listSanitizerRules,
  seedDefaultSanitizerRules,
  updateSanitizerRule,
} from "../../src/console/db/repos/sanitizer-rules";

beforeEach(() => {
  useIsolatedDataDir();
});

describe("sanitizer rules CRUD", () => {
  test("creates, lists, updates, and deletes a rule", () => {
    const created = createSanitizerRule({ ruleId: "test-rule", pattern: "secret-token", replacement: "[redacted]" });
    expect(created.ruleId).toBe("test-rule");
    expect(created.isActive).toBe(true);
    expect(created.isRegex).toBe(false);

    expect(listSanitizerRules()).toHaveLength(1);

    const updated = updateSanitizerRule(created.id, { isActive: false });
    expect(updated?.isActive).toBe(false);
    expect(listActiveSanitizerRules()).toHaveLength(0);

    expect(deleteSanitizerRule(created.id)).toBe(true);
    expect(listSanitizerRules()).toHaveLength(0);
  });

  test("rejects an invalid regex pattern on create", () => {
    expect(() => createSanitizerRule({ ruleId: "bad", pattern: "(unterminated", isRegex: true })).toThrow(InvalidPatternError);
  });

  test("rejects an invalid regex pattern on update", () => {
    const created = createSanitizerRule({ ruleId: "ok", pattern: "fine", isRegex: false });
    expect(() => updateSanitizerRule(created.id, { pattern: "(unterminated", isRegex: true })).toThrow(InvalidPatternError);
  });

  test("literal (non-regex) patterns are never validated as regex", () => {
    const created = createSanitizerRule({ ruleId: "literal", pattern: "(this is not regex", isRegex: false });
    expect(created.pattern).toBe("(this is not regex");
  });
});

describe("seedDefaultSanitizerRules", () => {
  test("seeds the default rule set once", () => {
    seedDefaultSanitizerRules();
    const afterFirstSeed = listSanitizerRules();
    expect(afterFirstSeed.length).toBeGreaterThan(0);

    seedDefaultSanitizerRules();
    expect(listSanitizerRules()).toHaveLength(afterFirstSeed.length);
  });

  test("adds missing built-ins without changing existing custom rules", () => {
    createSanitizerRule({ ruleId: "manual", pattern: "x" });
    seedDefaultSanitizerRules();
    const rules = listSanitizerRules();
    expect(rules.find((rule) => rule.ruleId === "manual")?.pattern).toBe("x");
    expect(rules.some((rule) => rule.ruleId === "billing-header")).toBe(true);
    expect(rules.some((rule) => rule.ruleId === "claude-code-mention")).toBe(true);
    expect(rules.some((rule) => rule.ruleId === "github-copilot-vscode-identity")).toBe(true);
    expect(rules.some((rule) => rule.ruleId === "github-copilot-model")).toBe(true);
  });
});
