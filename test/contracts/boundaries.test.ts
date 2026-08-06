import { describe, expect, test } from "bun:test";
import { normalizeRequest as normalizeFromDomain } from "../../src/domain";
import { normalizeRequest as normalizeFromProtocols } from "../../src/domain/protocols/index";
import { isRouteAllowed } from "../../src/console";
import { resolveConsoleStatic } from "../../src/console";

describe("stable source boundaries", () => {
  test("domain and grouped protocol barrels expose the same normalizer", () => {
    expect(normalizeFromDomain).toBe(normalizeFromProtocols);
  });

  test("routing snapshot construction lives at the application boundary", async () => {
    const domain = await import("../../src/domain");
    const snapshotModule = await import("../../src/app/routing-snapshot");
    expect(Object.hasOwn(domain, "createRouteSnapshotCache")).toBe(false);
    expect(Object.hasOwn(domain, "RoutingSnapshot")).toBe(false);
    expect(typeof snapshotModule.createRouteSnapshotCache).toBe("function");
  });

  test("console barrel exposes HTTP-safe helpers", async () => {
    expect(isRouteAllowed("openai", "gpt-4o", {})).toBe(true);
    expect(await resolveConsoleStatic("/console/login", async () => false)).toEqual({
      kind: "entry",
      file: "dashboard/dist/index.html",
    });
  });
});
