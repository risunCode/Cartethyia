/**
 * Unit tests for src/console/db/repos/sanitizer-rules.ts \u2014 pattern-based
 * outbound-text sanitizer rules (REQ-9): built-in defaults merged with DB
 * overrides, plus fully custom rules.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { useIsolatedDataDir } from "./helpers";
import {
  listSanitizerRules,
  listEffectiveSanitizerRules,
  resolveEffectiveFilterRules,
  createSanitizerRule,
  getSanitizerRuleById,
  upsertBuiltinSanitizerOverride,
  updateSanitizerRule,
  deleteSanitizerRule,
  resetBuiltinSanitizerOverride,
  InvalidPatternError,
  ReservedBuiltinRuleIdError,
} from "../../src/console/db/repos/sanitizer-rules";
import { DEFAULT_SANITIZER_RULES } from "../../src/console/default-sanitizer-rules";

beforeEach(() => {
  useIsolatedDataDir();
});

describe("listSanitizerRules \u2014 raw DB rows only", () => {
  test("is empty when no custom rules or overrides exist", () => {
    expect(listSanitizerRules()).toEqual([]);
  });

  test("returns a created custom rule", () => {
    createSanitizerRule({ ruleId: "my-custom-rule", pattern: "foo", replacement: "bar" });
    const rows = listSanitizerRules();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ruleId).toBe("my-custom-rule");
    expect(rows[0]!.builtin).toBe(false);
  });
});

describe("listEffectiveSanitizerRules \u2014 builtins + overrides + custom", () => {
  test("includes every built-in default even with no DB rows", () => {
    const effective = listEffectiveSanitizerRules();
    expect(effective.length).toBeGreaterThanOrEqual(DEFAULT_SANITIZER_RULES.length);
    expect(effective.every((r) => r.builtin)).toBe(true);
  });

  test("merges a DB override's pattern into the built-in entry", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    upsertBuiltinSanitizerOverride(builtinId, { pattern: "overridden-pattern" });
    const effective = listEffectiveSanitizerRules();
    const merged = effective.find((r) => r.ruleId === builtinId);
    expect(merged?.pattern).toBe("overridden-pattern");
    expect(merged?.builtin).toBe(true);
  });

  test("includes a custom rule alongside builtins", () => {
    createSanitizerRule({ ruleId: "custom-1", pattern: "x", replacement: "y" });
    const effective = listEffectiveSanitizerRules();
    expect(effective.some((r) => r.ruleId === "custom-1" && !r.builtin)).toBe(true);
  });
});

describe("resolveEffectiveFilterRules \u2014 hot-path active rule set", () => {
  test("includes all built-ins as active by default", () => {
    const rules = resolveEffectiveFilterRules();
    expect(rules.length).toBeGreaterThanOrEqual(DEFAULT_SANITIZER_RULES.length);
  });

  test("excludes a built-in that has been overridden to inactive", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    const builtinPattern = DEFAULT_SANITIZER_RULES[0]!.pattern;
    upsertBuiltinSanitizerOverride(builtinId, { isActive: false });
    const rules = resolveEffectiveFilterRules();
    expect(rules.some((r) => r.pattern === builtinPattern)).toBe(false);
  });

  test("includes an active custom rule", () => {
    createSanitizerRule({ ruleId: "custom-active", pattern: "needle", replacement: "" });
    const rules = resolveEffectiveFilterRules();
    expect(rules.some((r) => r.pattern === "needle")).toBe(true);
  });

  test("excludes an inactive custom rule", () => {
    createSanitizerRule({ ruleId: "custom-inactive", pattern: "needle2", replacement: "", isActive: false });
    const rules = resolveEffectiveFilterRules();
    expect(rules.some((r) => r.pattern === "needle2")).toBe(false);
  });
});

describe("createSanitizerRule", () => {
  test("rejects a ruleId that collides with a built-in id", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    expect(() => createSanitizerRule({ ruleId: builtinId, pattern: "x" })).toThrow(ReservedBuiltinRuleIdError);
  });

  test("rejects an invalid regex pattern when isRegex is true", () => {
    expect(() => createSanitizerRule({ ruleId: "bad-regex", pattern: "(unclosed", isRegex: true })).toThrow(InvalidPatternError);
  });

  test("allows a non-regex pattern that would be invalid as a regex", () => {
    expect(() => createSanitizerRule({ ruleId: "literal-paren", pattern: "(unclosed", isRegex: false })).not.toThrow();
  });
});

describe("getSanitizerRuleById", () => {
  test("resolves a custom rule by its positive numeric id", () => {
    const created = createSanitizerRule({ ruleId: "lookup-me", pattern: "p" });
    expect(getSanitizerRuleById(created.id)?.ruleId).toBe("lookup-me");
  });

  test("resolves a built-in rule via its synthetic negative id", () => {
    const effective = listEffectiveSanitizerRules();
    const builtin = effective.find((r) => r.builtin)!;
    expect(builtin.id).toBeLessThan(0);
    expect(getSanitizerRuleById(builtin.id)?.ruleId).toBe(builtin.ruleId);
  });

  test("returns null for an unknown id", () => {
    expect(getSanitizerRuleById(999_999)).toBeNull();
  });
});

describe("upsertBuiltinSanitizerOverride", () => {
  test("creates a new override row on first call", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    const result = upsertBuiltinSanitizerOverride(builtinId, { replacement: "REDACTED" });
    expect(result.replacement).toBe("REDACTED");
    expect(listSanitizerRules()).toHaveLength(1);
  });

  test("updates the existing override on a second call instead of duplicating", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    upsertBuiltinSanitizerOverride(builtinId, { replacement: "FIRST" });
    upsertBuiltinSanitizerOverride(builtinId, { replacement: "SECOND" });
    expect(listSanitizerRules()).toHaveLength(1);
    expect(listSanitizerRules()[0]!.replacement).toBe("SECOND");
  });

  test("throws for an unknown built-in ruleId", () => {
    expect(() => upsertBuiltinSanitizerOverride("does-not-exist", {})).toThrow();
  });
});

describe("updateSanitizerRule", () => {
  test("updates a custom rule's fields", () => {
    const created = createSanitizerRule({ ruleId: "update-me", pattern: "old" });
    const updated = updateSanitizerRule(created.id, { pattern: "new", isActive: false });
    expect(updated?.pattern).toBe("new");
    expect(updated?.isActive).toBe(false);
  });

  test("returns null when the target id does not exist", () => {
    expect(updateSanitizerRule(999_999, { pattern: "x" })).toBeNull();
  });

  test("routes a negative id to the built-in override path", () => {
    const effective = listEffectiveSanitizerRules();
    const builtin = effective.find((r) => r.builtin)!;
    const updated = updateSanitizerRule(builtin.id, { replacement: "via-negative-id" });
    expect(updated?.replacement).toBe("via-negative-id");
  });

  test("validates the new pattern when isRegex is (or becomes) true", () => {
    const created = createSanitizerRule({ ruleId: "regex-rule", pattern: "^valid$", isRegex: true });
    expect(() => updateSanitizerRule(created.id, { pattern: "(unclosed" })).toThrow(InvalidPatternError);
  });
});

describe("deleteSanitizerRule", () => {
  test("deletes a custom rule and returns true", () => {
    const created = createSanitizerRule({ ruleId: "delete-me", pattern: "p" });
    expect(deleteSanitizerRule(created.id)).toBe(true);
    expect(getSanitizerRuleById(created.id)).toBeNull();
  });

  test("returns false for an id that does not exist", () => {
    expect(deleteSanitizerRule(999_999)).toBe(false);
  });

  test("deleting a built-in override via negative id reverts it to the default", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    const builtinPattern = DEFAULT_SANITIZER_RULES[0]!.pattern;
    const override = upsertBuiltinSanitizerOverride(builtinId, { pattern: "temp-override" });
    expect(deleteSanitizerRule(override.id)).toBe(true);
    const effective = listEffectiveSanitizerRules().find((r) => r.ruleId === builtinId);
    expect(effective?.pattern).toBe(builtinPattern);
  });
});

describe("resetBuiltinSanitizerOverride", () => {
  test("removes an existing override", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    upsertBuiltinSanitizerOverride(builtinId, { pattern: "overridden" });
    expect(resetBuiltinSanitizerOverride(builtinId)).toBe(true);
    expect(listSanitizerRules()).toHaveLength(0);
  });

  test("returns false when there was no override to remove", () => {
    const builtinId = DEFAULT_SANITIZER_RULES[0]!.ruleId;
    expect(resetBuiltinSanitizerOverride(builtinId)).toBe(false);
  });
});
