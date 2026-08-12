import { describe, expect, test } from "bun:test";
import { RouteSessionStateStore } from "../../src/application/session-state";

describe("RouteSessionStateStore", () => {
  test("evicts entries after the idle TTL", () => {
    let now = 0;
    const store = new RouteSessionStateStore<{ id: string }>({ maxEntries: 4, idleTtlMs: 100, now: () => now });
    const state = store.create("route/provider/model", () => ({ id: "state-1" }));

    now = 99;
    expect(store.get("route/provider/model")).toBe(state);
    now = 198;
    expect(store.size).toBe(1);
    now = 199;
    expect(store.get("route/provider/model")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("evicts the oldest idle entry at the hard cap", () => {
    let now = 0;
    const store = new RouteSessionStateStore<{ id: string }>({ maxEntries: 2, idleTtlMs: 1_000, now: () => now });
    store.create("a", () => ({ id: "a" }));
    now = 1;
    store.create("b", () => ({ id: "b" }));
    now = 2;
    store.create("c", () => ({ id: "c" }));

    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.id).toBe("b");
    expect(store.get("c")?.id).toBe("c");
  });

  test("touching an entry changes deterministic eviction ordering", () => {
    let now = 0;
    const store = new RouteSessionStateStore<{ id: string }>({ maxEntries: 2, idleTtlMs: 1_000, now: () => now });
    store.create("a", () => ({ id: "a" }));
    now = 1;
    store.create("b", () => ({ id: "b" }));
    now = 2;
    expect(store.get("a")?.id).toBe("a");
    now = 3;
    store.create("c", () => ({ id: "c" }));

    expect(store.get("a")?.id).toBe("a");
    expect(store.get("b")).toBeUndefined();
    expect(store.inspect().map((entry) => entry.key)).toEqual(["c", "a"]);
  });

  test("supports update, delete, keyed reset, predicate reset, and full reset", () => {
    const store = new RouteSessionStateStore<{ value: number }>({ maxEntries: 8, idleTtlMs: 1_000 });
    store.create("route-a/provider/model-a", () => ({ value: 1 }));
    store.create("route-a/provider/model-b", () => ({ value: 2 }));
    store.create("route-b/provider/model-a", () => ({ value: 3 }));

    expect(store.update("route-a/provider/model-a", (state) => ({ value: state.value + 10 }))).toEqual({ value: 11 });
    expect(store.delete("route-b/provider/model-a")).toBe(true);
    expect(store.reset((entry) => entry.key.startsWith("route-a/"))).toBe(2);
    expect(store.size).toBe(0);

    store.create("route-c/provider/model-c", () => ({ value: 4 }));
    expect(store.reset("route-c/provider/model-c")).toBe(1);
    store.create("route-d/provider/model-d", () => ({ value: 5 }));
    expect(store.reset()).toBe(1);
    expect(store.size).toBe(0);
  });
});
