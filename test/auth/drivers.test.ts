import { describe, expect, test } from "bun:test";
import { MapAuthDriverRegistry, createAuthDriverRegistry } from "../../src/auth/drivers";
import type { AuthDriver } from "../../src/auth/contracts";

function fakeDriver(_id: string): AuthDriver {
  return { kind: "oauth" };
}

describe("MapAuthDriverRegistry", () => {
  test("registers, gets, and reports has", () => {
    const registry = new MapAuthDriverRegistry();
    registry.register("a", fakeDriver("a"));
    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("a")).not.toBeNull();
    expect(registry.get("missing")).toBeNull();
  });

  test("later registrations replace earlier ones for the same id", () => {
    const registry = new MapAuthDriverRegistry();
    registry.register("a", fakeDriver("a1"));
    registry.register("a", fakeDriver("a2"));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("a")).not.toBe(fakeDriver("a1"));
  });

  test("register rejects an empty provider id", () => {
    const registry = new MapAuthDriverRegistry();
    expect(() => registry.register("", fakeDriver("x"))).toThrowError(/empty/);
  });
});

describe("createAuthDriverRegistry", () => {
  test("registers the bundled codex driver by default", () => {
    const registry = createAuthDriverRegistry();
    expect(registry.has("codex")).toBe(true);
    expect(registry.get("unknown")).toBeNull();
  });

  test("registers additional providers from the initial entries", () => {
    const registry = createAuthDriverRegistry([{ providerId: "kiro", driver: fakeDriver("kiro") }]);
    expect(registry.has("codex")).toBe(true);
    expect(registry.has("kiro")).toBe(true);
    expect(registry.list().map((entry) => entry.providerId)).toContain("kiro");
  });

  test("initial entries can replace a bundled driver", () => {
    const registry = createAuthDriverRegistry([{ providerId: "codex", driver: fakeDriver("override") }]);
    expect(registry.list().filter((entry) => entry.providerId === "codex")).toHaveLength(1);
  });
});
