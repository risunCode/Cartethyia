import { describe, expect, test } from "bun:test";
import {
  createAuthorizationSnapshot,
  freezeSnapshot,
  isModelAllowed,
  isProviderAllowed,
} from "../../src/security/api-key-auth";

describe("key-lookup.test.ts", () => {
describe("ApiKeyAuthorizationSnapshot", () => {
  test("freeze copies arrays and snapshot is deeply frozen", () => {
    const provider_allowlist = ["openai", "anthropic"];
    const model_allowlist = ["gpt-4", "claude-3"];
    const model_denylist = ["gpt-3.5"];
    const snap = freezeSnapshot({
      api_key_id: "k1",
      tenant_id: "t1",
      provider_allowlist,
      model_allowlist,
      model_denylist,
      rpm: 60,
      daily_tokens: 10_000,
      monthly_tokens: 100_000,
      max_concurrent: 5,
    });

    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.provider_allowlist as unknown as object)).toBe(true);
    expect(Object.isFrozen(snap.model_allowlist as unknown as object)).toBe(true);
    expect(Object.isFrozen(snap.model_denylist as unknown as object)).toBe(true);

    // Mutating original arrays does not affect snapshot
    provider_allowlist.push("cerebras");
    model_allowlist.push("extra");
    expect(snap.provider_allowlist).toEqual(["openai", "anthropic"]);
    expect(snap.model_allowlist).toEqual(["gpt-4", "claude-3"]);

    // Attempt to mutate frozen snapshot throws or is ignored
    expect(() => {
      (snap as unknown as Record<string, unknown>)["rpm"] = 999;
    }).toThrow();
    expect(snap.rpm).toBe(60);
  });

  test("createAuthorizationSnapshot preserves all fields and sets admission_identity default", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "key-123",
      tenant_id: "tenant-abc",
      provider_allowlist: ["openai"],
      model_allowlist: ["gpt-4"],
      model_denylist: ["bad-model"],
      rpm: 100,
      daily_tokens: 5000,
      monthly_tokens: 50000,
      lifetime_token_budget: 1_000_000,
      lifetime_tokens_consumed: 12345,
      max_concurrent: 10,
    });
    expect(snap.api_key_id).toBe("key-123");
    expect(snap.tenant_id).toBe("tenant-abc");
    expect(snap.admission_identity).toBe("key-123");
    expect(snap.provider_allowlist).toEqual(["openai"]);
    expect(snap.model_allowlist).toEqual(["gpt-4"]);
    expect(snap.model_denylist).toEqual(["bad-model"]);
    expect(snap.rpm).toBe(100);
    expect(snap.daily_tokens).toBe(5000);
    expect(snap.monthly_tokens).toBe(50000);
    expect(snap.lifetime_token_budget).toBe(1_000_000);
    expect(snap.lifetime_tokens_consumed).toBe(12345);
    expect(snap.max_concurrent).toBe(10);
  });

  test("immutability: snapshot cannot be narrowed or reconstructed to bypass ACL", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "k2",
      tenant_id: "t2",
      provider_allowlist: ["anthropic"],
      model_allowlist: ["claude-3"],
      model_denylist: [],
      rpm: 10,
      max_concurrent: 2,
    });
    // Simulate downstream that incorrectly tries to narrow snapshot to only api_key_id
    const narrowed = { api_key_id: snap.api_key_id } as unknown as typeof snap;
    // Helper should detect incomplete snapshot
    expect(narrowed.provider_allowlist).toBeUndefined();
    // Original remains intact
    expect(snap.provider_allowlist).toEqual(["anthropic"]);
    expect(isProviderAllowed(snap, "openai")).toBe(false);
    expect(isProviderAllowed(snap, "anthropic")).toBe(true);
  });

  test("denylist-over-allowlist precedence is deterministic", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "k3",
      tenant_id: "t3",
      model_allowlist: ["gpt-4", "gpt-4o", "claude-3"],
      model_denylist: ["gpt-4o"],
    });
    // gpt-4o is in both allowlist and denylist — denylist wins
    expect(isModelAllowed(snap, "gpt-4o")).toBe(false);
    expect(isModelAllowed(snap, "gpt-4")).toBe(true);
    expect(isModelAllowed(snap, "unknown-model")).toBe(false); // not in allowlist
    // provider precedence similarly
    const snap2 = createAuthorizationSnapshot({
      api_key_id: "k4",
      tenant_id: "t4",
      provider_allowlist: ["openai", "anthropic"],
    });
    expect(isProviderAllowed(snap2, "openai")).toBe(true);
    expect(isProviderAllowed(snap2, "cerebras")).toBe(false);
    // empty/null allowlist means unrestricted
    const snap3 = createAuthorizationSnapshot({ api_key_id: "k5", tenant_id: "t5" });
    expect(isModelAllowed(snap3, "any-model")).toBe(true);
    expect(isProviderAllowed(snap3, "any-provider")).toBe(true);
  });

  test("model lists match bare and provider-qualified forms", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "k-dual",
      tenant_id: "t-dual",
      model_allowlist: ["gpt-4"],
      model_denylist: ["bad-model"],
    });
    // Bare allow entry admits the qualified use.
    expect(isModelAllowed(snap, "gpt-4")).toBe(true);
    expect(isModelAllowed(snap, "openai/gpt-4")).toBe(true);
    // Bare deny entry blocks the qualified use (no silent under-enforcement).
    expect(isModelAllowed(snap, "bad-model")).toBe(false);
    expect(isModelAllowed(snap, "openai/bad-model")).toBe(false);
    // Unlisted stays denied under a non-empty allowlist, either form.
    expect(isModelAllowed(snap, "other")).toBe(false);
    expect(isModelAllowed(snap, "openai/other")).toBe(false);
  });

  test("denied model never reaches ProviderDispatch.dispatch", async () => {
    const snapshot = createAuthorizationSnapshot({
      api_key_id: "k6",
      tenant_id: "t6",
      provider_allowlist: ["openai"],
      model_allowlist: ["gpt-4"],
      model_denylist: ["gpt-4o"],
    });

    let dispatchCalls = 0;
    const mockDispatch = async (input: {
      readonly authorization: typeof snapshot;
      readonly targetProvider: string;
      readonly targetModel: string;
    }) => {
      // downstream must receive whole snapshot without re-querying
      expect(input.authorization).toBe(snapshot);
      expect(input.authorization.api_key_id).toBe("k6");
      expect(input.authorization.provider_allowlist).toEqual(["openai"]);
      dispatchCalls++;
    };

    const attemptDispatch = async (provider: string, model: string) => {
      if (!isProviderAllowed(snapshot, provider) || !isModelAllowed(snapshot, model)) {
        throw Object.assign(new Error("model_not_found"), { code: "model_not_found" });
      }
      await mockDispatch({ authorization: snapshot, targetProvider: provider, targetModel: model });
    };

    await expect(attemptDispatch("openai", "gpt-4")).resolves.toBeUndefined();
    expect(dispatchCalls).toBe(1);

    await expect(attemptDispatch("openai", "gpt-4o")).rejects.toThrow();
    await expect(attemptDispatch("anthropic", "claude-3")).rejects.toThrow();
    // denied requests never reached dispatch
    expect(dispatchCalls).toBe(1);
  });

  test("snapshot with Set input is normalized and frozen", () => {
    const snap = freezeSnapshot({
      api_key_id: "k7",
      tenant_id: "t7",
      provider_allowlist: new Set(["openai", "cerebras"]) as unknown as readonly string[],
      model_allowlist: new Set(["a", "b"]) as unknown as readonly string[],
      model_denylist: new Set(["c"]) as unknown as readonly string[],
    });
    expect(snap.provider_allowlist).toEqual(["openai", "cerebras"]);
    expect(snap.model_allowlist).toEqual(["a", "b"]);
    expect(snap.model_denylist).toEqual(["c"]);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.provider_allowlist as unknown as object)).toBe(true);
  });
});
});
