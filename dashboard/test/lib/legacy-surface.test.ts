import { describe, expect, test } from "vitest";

const sources = import.meta.glob("../../src/**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const forbidden = /\bapi(?:Get|Post|PostForm|Patch|Delete)\b|\/custom-providers|\/aliases|\/combos|\/model-studio|\/db-map|\/proxy-requests|\bQUERY\b|\/v2\/admin|\/console\/api/;
// Module names deleted in v2.1 (WS3). `\bPopout\b` is case-sensitive on
// purpose: alive files legitimately use the lowercase `popout-enter` CSS
// class, while the deleted component was `Popout`.
const deletedModules = /dashboard-fetch|use-inflight-stream|\bPopout\b|model-picker|header-pairs-editor|use-share-data|use-auth|use-runtime-settings|use-selection-set|use-console-observability|provider-icon|status-dot|query-keys|types\/api|lib\/(theme|files|errors)\b|async-state|selection-toolbar|clipboard-button|composables\/auth/;

describe("retained dashboard surface", () => {
  test("does not retain legacy helpers, routes, or QUERY methods", () => {
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toMatch(forbidden);
    }
  });

  test("does not resurrect modules deleted in v2.1", () => {
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toMatch(deletedModules);
    }
  });
});
