import { describe, expect, test } from "vitest";

const sources = import.meta.glob("../../src/**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const forbidden = /\bapi(?:Get|Post|PostForm|Patch|Delete)\b|\/custom-providers|\/aliases|\/combos|\/model-studio|\/db-map|\/proxy-requests|\bQUERY\b/;

describe("retained dashboard surface", () => {
  test("does not retain legacy helpers, routes, or QUERY methods", () => {
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toMatch(forbidden);
    }
  });
});
