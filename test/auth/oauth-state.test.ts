import { describe, expect, test } from "bun:test";
import { OAuthStateManager } from "../../src/auth/oauth-state";

describe("OAuthStateManager", () => {
  let now = 1_000_000;
  const nowMs = () => now;

  test("create returns a bounded record with expiry", () => {
    const m = new OAuthStateManager({ nowMs, randomState: () => "st-1" });
    const record = m.create({ providerId: "codex" });
    expect(record.state).toBe("st-1");
    expect(record.providerId).toBe("codex");
    expect(record.expiresAtMs).toBe(now + 10 * 60_000);
    expect(m.size()).toBe(1);
  });

  test("consume succeeds once and then null", () => {
    const m = new OAuthStateManager({ nowMs, randomState: () => "st-1" });
    m.create({ providerId: "codex" });
    const first = m.consume("st-1", "codex");
    expect(first?.providerId).toBe("codex");
    expect(m.consume("st-1", "codex")).toBeNull();
  });

  test("rejects provider mismatched or expired state", () => {
    const m = new OAuthStateManager({ nowMs });
    m.create({ providerId: "codex", state: "st-a" });
    expect(m.consume("st-a", "claude")).toBeNull();
    // re-create then expire
    m.create({ providerId: "codex", state: "st-b" });
    now += 11 * 60_000;
    expect(m.consume("st-b", "codex")).toBeNull();
  });

  test("evicts oldest when over maxStates", () => {
    let counter = 0;
    const m = new OAuthStateManager({ nowMs, maxStates: 2, randomState: () => `st-${++counter}` });
    m.create({ providerId: "a" });
    m.create({ providerId: "b" });
    m.create({ providerId: "c" });
    expect(m.size()).toBe(2);
    // oldest ("a") was evicted
    expect(m.consume("st-1", "a")).toBeNull();
  });

  test("sweeps expired entries on size", () => {
    const m = new OAuthStateManager({ nowMs });
    m.create({ providerId: "a", state: "old" });
    now += 11 * 60_000;
    expect(m.size()).toBe(0);
  });

  test("clear empties the store", () => {
    const m = new OAuthStateManager({ nowMs });
    m.create({ providerId: "a" });
    m.clear();
    expect(m.size()).toBe(0);
  });

  test("create with explicit state + codeVerifier keeps them", () => {
    const m = new OAuthStateManager({ nowMs });
    const record = m.create({ providerId: "anthropic", state: "manual", codeVerifier: "vc", redirectUri: "http://localhost:8080/cb" });
    expect(record.codeVerifier).toBe("vc");
    expect(record.redirectUri).toBe("http://localhost:8080/cb");
  });
});
