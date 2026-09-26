import { describe, expect, expectTypeOf, test } from "bun:test";
import { healthStatus } from "../../src/persistence/schema";
import type { HealthStatus } from "../src/lib/contracts";

/**
 * `HealthStatus` (dashboard) is derived from the backend `health_status`
 * pgEnum — this pins the derivation both statically (exact union) and at
 * runtime (enum values), so a backend state addition/removal fails here
 * instead of silently widening dashboard status handling.
 */
describe("dashboard/backend parity — health status", () => {
  test("HealthStatus is exactly the pgEnum union", () => {
    expectTypeOf<HealthStatus>().toEqualTypeOf<"active" | "cooldown" | "disabled">();
    expect([...healthStatus.enumValues].sort()).toEqual([
      "active",
      "cooldown",
      "disabled",
    ]);
  });
});
