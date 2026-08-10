import { describe, expect, test } from "vitest";
import { ADVANCED_NAV_GROUPS, ADVANCED_PATHS, NAV_GROUPS, TITLES } from "../../src/app/navigation";

describe("dashboard navigation metadata", () => {
  test("keeps every navigable sidebar path unique", () => {
    const paths = [...NAV_GROUPS, ...ADVANCED_NAV_GROUPS]
      .flatMap((group) => group.items.map((item) => item.to))
      .filter(Boolean);

    expect(new Set(paths).size).toBe(paths.length);
  });

  test("keeps advanced navigation paths and titles aligned", () => {
    const advancedPaths = ADVANCED_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));

    expect(advancedPaths.every((path) => ADVANCED_PATHS.has(path))).toBe(true);
    expect(advancedPaths.filter((path) => path !== "/advanced/automation").every((path) => TITLES[path] !== undefined)).toBe(true);
    expect(TITLES["/advanced/cli-tools/:toolId"]).toMatchObject({ title: "CLI Tool" });
  });
});
