import { describe, expect, test } from "vitest";
import { NAV_GROUPS, TITLES } from "../../src/console/navigation";

describe("dashboard navigation metadata", () => {
  test("keeps every navigable sidebar path unique", () => {
    const paths = NAV_GROUPS
      .flatMap((group) => group.items.map((item) => item.to))
      .filter(Boolean);

    expect(new Set(paths).size).toBe(paths.length);
  });

  test("keeps retained navigation paths and titles aligned", () => {
    const paths = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));

    expect(paths.every((path) => TITLES[path] !== undefined)).toBe(true);
  });
});
