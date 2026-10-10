import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Anchored to this file's location, not the process cwd: the runner
// (`ci-run-tests.ts`) executes with `cwd = dashboard/`, so a repo-relative
// path fails to resolve. One level up from `test/` is the dashboard root.
const pagePath = fileURLToPath(new URL("../src/features/providers/ProvidersPage.tsx", import.meta.url));

describe("web session provider section", () => {
  test("places web providers immediately after free limited providers", () => {
    const source = readFileSync(pagePath, "utf8");
    const freeAt = source.indexOf('title: "Free Limited Providers"');
    const webAt = source.indexOf('title: "Web Session Providers"');
    const otherAt = source.indexOf('title: "Other API Key Providers"');
    expect(freeAt).toBeGreaterThan(0);
    expect(webAt).toBeGreaterThan(freeAt);
    expect(otherAt).toBeGreaterThan(webAt);
    expect(source).toContain('const WEB_LLM_IDS = new Set(["claude-web", "grok-web", "kimi-web"])');
    expect(source).toContain("!WEB_LLM_IDS.has(p.providerId.toLowerCase())");
  });
});
