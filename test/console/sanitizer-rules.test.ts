/** Sanitizer rules repo tests — CRUD, invalid-regex rejection, built-in defaults (REQ-9). */

import { beforeEach, describe, expect, test } from "bun:test";
import { useIsolatedDataDir } from "./helpers";
import {
  createSanitizerRule,
  deleteSanitizerRule,
  InvalidPatternError,
  listEffectiveSanitizerRules,
  listSanitizerRules,
  ReservedBuiltinRuleIdError,
  resolveEffectiveFilterRules,
  updateSanitizerRule,
  upsertBuiltinSanitizerOverride,
} from "../../src/console/db/repos/sanitizer-rules";
import { DEFAULT_SANITIZER_RULES } from "../../src/console/default-sanitizer-rules";

beforeEach(() => {
  useIsolatedDataDir();
});

describe("sanitizer rules CRUD", () => {
  test("creates, lists, updates, and deletes a custom rule", () => {
    const created = createSanitizerRule({ ruleId: "test-rule", pattern: "secret-token", replacement: "[redacted]" });
    expect(created.ruleId).toBe("test-rule");
    expect(created.isActive).toBe(true);
    expect(created.isRegex).toBe(false);
    expect(created.builtin).toBe(false);

    expect(listSanitizerRules()).toHaveLength(1);

    const updated = updateSanitizerRule(created.id, { isActive: false });
    expect(updated?.isActive).toBe(false);
    expect(resolveEffectiveFilterRules().some((rule) => rule.pattern === "secret-token")).toBe(false);

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

  test("cannot create a duplicate built-in rule id", () => {
    expect(() => createSanitizerRule({ ruleId: "billing-header", pattern: "x" })).toThrow(ReservedBuiltinRuleIdError);
  });
});

describe("built-in sanitizer defaults", () => {
  test("exposes built-ins without seeding the database", () => {
    expect(listSanitizerRules()).toHaveLength(0);
    expect(listEffectiveSanitizerRules().length).toBe(DEFAULT_SANITIZER_RULES.length);
    expect(resolveEffectiveFilterRules().length).toBe(DEFAULT_SANITIZER_RULES.length);
  });

  test("stores only overrides for built-ins in the database", () => {
    upsertBuiltinSanitizerOverride("cc-entrypoint", { isActive: false });
    expect(listSanitizerRules()).toHaveLength(1);
    const effective = listEffectiveSanitizerRules().find((rule) => rule.ruleId === "cc-entrypoint");
    expect(effective?.isActive).toBe(false);
    expect(resolveEffectiveFilterRules().some((rule) => rule.pattern.includes("cc_entrypoint"))).toBe(false);
  });

  test("keeps custom rules alongside built-ins", () => {
    createSanitizerRule({ ruleId: "manual", pattern: "x" });
    const rules = listEffectiveSanitizerRules();
    expect(rules.find((rule) => rule.ruleId === "manual")?.pattern).toBe("x");
    expect(rules.some((rule) => rule.ruleId === "billing-header")).toBe(true);
    expect(rules.some((rule) => rule.ruleId === "claude-code-mention")).toBe(true);
  });
});
