import { describe, expect, test } from "bun:test";

import { resolveDashboardApp } from "./app-entry";

describe("dashboard app entry resolution", () => {
  test("uses the console app for the console mount and deep links", () => {
    expect(resolveDashboardApp("/console")).toBe("console");
    expect(resolveDashboardApp("/console/")).toBe("console");
    expect(resolveDashboardApp("/console/overview")).toBe("console");
  });

  test("uses the landing app for the root document", () => {
    expect(resolveDashboardApp("/")).toBe("landing");
  });
});
