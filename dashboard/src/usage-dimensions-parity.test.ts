import { describe, expect, expectTypeOf, test } from "bun:test";
import { USAGE_DIMENSIONS, type UsageDimension } from "./lib/contracts";
import {
  USAGE_DIMENSIONS as BACKEND_DIMENSIONS,
  type UsageDimension as BackendUsageDimension,
} from "../../src/console/domains/stats/contracts";

/**
 * The Usage page's breakdown tabs, the `?dim=` query parser, and the backend
 * route table all key off one dimension list. Before this, the backend
 * restated the four members in a validator, the route file repeated them as
 * four hand-written `.get("/system/usage/by-<x>")` registrations, and the
 * dashboard declared its own `Dimension` union — three copies that had to be
 * edited together, with nothing comparing them.
 */
describe("dashboard/backend parity — usage dimensions", () => {
  test("the dashboard exports the backend tuple itself, not a copy", () => {
    expect(USAGE_DIMENSIONS).toBe(BACKEND_DIMENSIONS);
    expectTypeOf<UsageDimension>().toEqualTypeOf<BackendUsageDimension>();
  });

  test("the dimension list is exactly what the UI offers", () => {
    expect([...USAGE_DIMENSIONS]).toEqual(["model", "provider", "key", "client", "client_ip"]);
  });
});
