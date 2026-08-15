import { describe, expect, test } from "vitest";
import { CONSOLE_ROUTE_PATHS } from "../../src/console/router";

describe("dashboard router", () => {
  test("keeps the retained console sections registered", () => {
    expect(Object.values(CONSOLE_ROUTE_PATHS)).toEqual([
      "/login",
      "/",
      "/overview",
      "/usage",
      "/providers",
      "/providers/:id",
      "/settings",
      "*404",
    ]);
  });

  test("does not retain retired feature routes", () => {
    const paths = Object.values(CONSOLE_ROUTE_PATHS);

    expect(paths).not.toContain("/quota");
    expect(paths).not.toContain("/console-log");
    expect(paths).not.toContain("/advanced");
    expect(paths).not.toContain("/advanced/automation");
  });
});
