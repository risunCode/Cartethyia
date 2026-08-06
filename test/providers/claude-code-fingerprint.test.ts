import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  claudeBillingHeaderPrefix,
  claudeCchPlaceholder,
  claudeCchSeed,
  claudeCodeOAuthBetas,
  claudeCodeSystemInstruction,
  claudeCodeVersion,
  claudeToolPrefix,
} from "../../src/providers/claude-code-fingerprint";

describe("claude-code-fingerprint constants", () => {
  test("claudeCodeVersion matches the expected Claude Code release version", () => {
    expect(claudeCodeVersion).toBe("2.1.165");
    expect(typeof claudeCodeVersion).toBe("string");
  });

  test("claudeBillingHeaderPrefix is the lowercase Anthropic billing header key", () => {
    expect(claudeBillingHeaderPrefix).toBe("x-anthropic-billing-header:");
    expect(claudeBillingHeaderPrefix.endsWith(":")).toBe(true);
  });

  test("claudeCchPlaceholder is the canonical CCH placeholder string", () => {
    expect(claudeCchPlaceholder).toBe("cch=00000");
  });

  test("claudeCchSeed is the expected 64-bit BigInt seed", () => {
    expect(claudeCchSeed).toBe(0x4d659218e32a3268n);
    expect(typeof claudeCchSeed).toBe("bigint");
  });

  test("claudeCodeSystemInstruction matches the Claude Agent SDK identity string", () => {
    expect(claudeCodeSystemInstruction).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  });

  test("claudeToolPrefix is the underscore prefix used for Claude Code tools", () => {
    expect(claudeToolPrefix).toBe("_");
  });

  test("CLAUDE_CODE_MAX_OUTPUT_TOKENS is the documented 64000 ceiling", () => {
    expect(CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(64000);
    expect(typeof CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("number");
    expect(Number.isInteger(CLAUDE_CODE_MAX_OUTPUT_TOKENS)).toBe(true);
    expect(CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
  });
});

describe("claudeCodeOAuthBetas", () => {
  test("is a readonly tuple declared with as const", () => {
    expect(Array.isArray(claudeCodeOAuthBetas)).toBe(true);
    // Declared with `as const` — TypeScript readonly, but not Object.frozen at runtime.
    expect(claudeCodeOAuthBetas.length).toBe(9);
  });

  test("contains the claude-code beta sentinel", () => {
    expect(claudeCodeOAuthBetas).toContain("claude-code-20250219");
  });

  test("contains the OAuth beta sentinel", () => {
    expect(claudeCodeOAuthBetas).toContain("oauth-2025-04-20");
  });

  test("contains the interleaved-thinking beta", () => {
    expect(claudeCodeOAuthBetas).toContain("interleaved-thinking-2025-05-14");
  });

  test("contains the context-management beta", () => {
    expect(claudeCodeOAuthBetas).toContain("context-management-2025-06-27");
  });

  test("contains the prompt-caching-scope beta", () => {
    expect(claudeCodeOAuthBetas).toContain("prompt-caching-scope-2026-01-05");
  });

  test("contains the mid-conversation-system beta", () => {
    expect(claudeCodeOAuthBetas).toContain("mid-conversation-system-2026-04-07");
  });

  test("contains the advanced-tool-use beta", () => {
    expect(claudeCodeOAuthBetas).toContain("advanced-tool-use-2025-11-20");
  });

  test("contains the effort beta", () => {
    expect(claudeCodeOAuthBetas).toContain("effort-2025-11-24");
  });

  test("contains the extended-cache-ttl beta", () => {
    expect(claudeCodeOAuthBetas).toContain("extended-cache-ttl-2025-04-11");
  });

  test("has exactly nine beta strings with no duplicates", () => {
    const unique = new Set(claudeCodeOAuthBetas);
    expect(unique.size).toBe(claudeCodeOAuthBetas.length);
    expect(claudeCodeOAuthBetas.length).toBe(9);
  });

  test("every beta string follows a name-date-suffix convention", () => {
    for (const beta of claudeCodeOAuthBetas) {
      // Some betas use YYYYMMDD (claude-code-20250219), others use YYYY-MM-DD.
      expect(beta).toMatch(/^[a-z-]+-(\d{4}-\d{2}-\d{2}|\d{8})$/);
    }
  });
});
