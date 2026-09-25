import { describe, expect, test } from "bun:test";

import { resolveDashboardApp } from "../../src/lib/app-entry";

describe("dashboard app entry resolution", () => {
  test("uses the console app for console roots and deep links", () => {
    expect(resolveDashboardApp("/console")).toBe("console");
    expect(resolveDashboardApp("/console/")).toBe("console");
    expect(resolveDashboardApp("/console/share")).toBe("console");
  });

  test("uses the share app for enrollment roots and deep links", () => {
    expect(resolveDashboardApp("/share")).toBe("share");
    expect(resolveDashboardApp("/share/token")).toBe("share");
    expect(resolveDashboardApp("/share/token/issue")).toBe("share");
  });

  test("uses the landing app for the root document", () => {
    expect(resolveDashboardApp("/")).toBe("landing");
  });
});
