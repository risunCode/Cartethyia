import { describe, expect, test } from "bun:test";
import { toggleInSet } from "./routes/Usage";

/**
 * The Usage page's per-panel widen control flips one key in a `ReadonlySet`.
 * The panels are independent, so widening one must never disturb the other —
 * that independence is the whole point of tracking them as a set rather than
 * two booleans that a future edit could cross-wire.
 */
describe("usage panel width toggles", () => {
  test("adds a key that is absent and removes one that is present", () => {
    expect([...toggleInSet(new Set<string>(), "traffic")]).toEqual(["traffic"]);
    expect([...toggleInSet(new Set(["traffic"]), "traffic")]).toEqual([]);
  });

  test("toggling twice returns to the original state", () => {
    const start = new Set(["traffic"]);
    const roundTrip = toggleInSet(toggleInSet(start, "breakdown"), "breakdown");
    expect([...roundTrip].sort()).toEqual(["traffic"]);
  });

  test("leaves the input set unmutated", () => {
    const start = new Set(["traffic"]);
    toggleInSet(start, "breakdown");
    expect([...start]).toEqual(["traffic"]);
  });

  test("panels are independent: widening one leaves the other alone", () => {
    // Both panels share the widen set, so widening Traffic must not widen
    // Breakdown, and restoring one must leave the other wide.
    let wide = new Set<string>();
    wide = toggleInSet(wide, "traffic");
    expect([...wide]).toEqual(["traffic"]);

    wide = toggleInSet(wide, "breakdown");
    expect([...wide].sort()).toEqual(["breakdown", "traffic"]);

    wide = toggleInSet(wide, "traffic");
    expect([...wide]).toEqual(["breakdown"]);
  });
});
