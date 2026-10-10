import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("web session provider section", () => {
  test("places web providers immediately after free limited providers", () => {
    const source = readFileSync("dashboard/src/features/providers/ProvidersPage.tsx", "utf8");
    const freeAt = source.indexOf('title: "Free Limited Providers"');
    const webAt = source.indexOf('title: "Web Session Providers"');
    const otherAt = source.indexOf('title: "Other API Key Providers"');
    expect(freeAt).toBeGreaterThan(0);
    expect(webAt).toBeGreaterThan(freeAt);
    expect(otherAt).toBeGreaterThan(webAt);
    expect(source).toContain('const WEB_LLM_IDS = new Set(["claude-web"])');
    expect(source).toContain("!WEB_LLM_IDS.has(p.providerId.toLowerCase())");
  });
});
