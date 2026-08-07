import { describe, expect, test } from "bun:test";
import {
  expandCombo,
  parseModelReference,
  resolveAlias,
  resolveModelChain,
  type ComboDefinition,
  type ModelReferenceConfig,
} from "../../src/domain/routing";
import type { AffinityKey } from "../../src/domain/contracts";

const PREFIXES = new Map<string, string>([
  ["openai", "openai"],
  ["anthropic", "anthropic"],
  ["opencodeft", "opencodeft"],
]);

describe("model reference precedence", () => {
  test("parses provider-qualified names and rejects unknown or empty prefixes", () => {
    expect(parseModelReference("opencodeft/grok-code-fast", new Map([["opencodeft", "opencodeft"]]))).toEqual({
      kind: "qualified",
      providerId: "opencodeft",
      modelId: "grok-code-fast",
    });
    expect(parseModelReference("gpt-5", PREFIXES)).toEqual({ kind: "unqualified" });
    expect(parseModelReference("nope/model", PREFIXES)).toMatchObject({ kind: "invalid" });
    expect(parseModelReference("/model", PREFIXES)).toMatchObject({ kind: "invalid" });
    // Empty-segment model IDs like "openai//x" split at the first slash:
    // prefix="openai", modelId="/x" — qualified, not rejected. The modelId
    // keeps the leading slash; downstream gates simply won't find it in the
    // catalog, so it resolves to nothing at dispatch time.
    expect(parseModelReference("openai//x", PREFIXES)).toEqual({
      kind: "qualified",
      providerId: "openai",
      modelId: "/x",
    });
  });

  test("resolves qualified names over aliases and aliases over combos", () => {
    const config: ModelReferenceConfig = {
      prefixes: PREFIXES,
      aliases: new Map([
        ["fast", "openai/gpt-5"],
        ["alias-to-combo", "trio"],
        ["shadow", "gpt-5"], // alias targeting a raw name: falls through to unresolved
      ]),
      combos: new Map([
        ["trio", { id: "trio", models: ["openai/gpt-5", "anthropic/claude-sonnet-4-5", "openai/gpt-5"], strategy: "fallback", stickyLimit: 0 }],
      ]),
    };

    expect(resolveModelChain("openai/gpt-5", config)).toEqual({ kind: "qualified", model: { providerId: "openai", modelId: "gpt-5" } });
    // Alias wins over any raw-name interpretation.
    expect(resolveModelChain("fast", config)).toEqual({ kind: "qualified", model: { providerId: "openai", modelId: "gpt-5" } });
    expect(resolveAlias("fast", config.aliases)).toBe("openai/gpt-5");
    expect(resolveAlias("missing", config.aliases)).toBeNull();

    // Combo keeps definition order for "fallback" and drops duplicate targets.
    const combo = resolveModelChain("trio", config);
    expect(combo.kind).toBe("combo");
    if (combo.kind !== "combo") return;
    expect(combo.candidates).toEqual([
      { providerId: "openai", modelId: "gpt-5" },
      { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    ]);

    // Alias to a combo name resolves through the chain.
    expect(resolveModelChain("alias-to-combo", config).kind).toBe("combo");
    // Alias to an unknown raw name stays unresolved (caller treats as passthrough).
    expect(resolveModelChain("shadow", config)).toEqual({ kind: "unresolved" });
    expect(resolveModelChain("unknown-model", config)).toEqual({ kind: "unresolved" });
  });

  test("round-robin combos rotate deterministically with affinity stickiness", () => {
    const config: ModelReferenceConfig = {
      prefixes: PREFIXES,
      aliases: new Map(),
      combos: new Map([["rr", { id: "rr", models: ["openai/a", "openai/b", "openai/c"], strategy: "round-robin", stickyLimit: 1 }]]),
    };
    const keyA: AffinityKey = { namespace: "api_key", value: "user-1" };
    const keyB: AffinityKey = { namespace: "api_key", value: "user-2" };

    const first = resolveModelChain("rr", config, keyA);
    const second = resolveModelChain("rr", config, keyA);
    expect(first.kind).toBe("combo");
    if (first.kind !== "combo" || second.kind !== "combo") return;
    // Same affinity key -> same deterministic order.
    expect(first.candidates).toEqual(second.candidates);
    // Order is always a permutation of the members.
    expect([...first.candidates].map((model) => model.modelId).sort()).toEqual(["a", "b", "c"]);
    const other = resolveModelChain("rr", config, keyB);
    if (other.kind !== "combo") return;
    expect([...other.candidates].map((model) => model.modelId).sort()).toEqual(["a", "b", "c"]);
  });

  test("fallback combos keep definition order regardless of affinity", () => {
    const config: ModelReferenceConfig = {
      prefixes: PREFIXES,
      aliases: new Map(),
      combos: new Map([["fb", { id: "fb", models: ["openai/a", "openai/b"], strategy: "fallback", stickyLimit: 10 }]]),
    };
    const result = resolveModelChain("fb", config, { namespace: "api_key", value: "user-1" });
    expect(result.kind).toBe("combo");
    if (result.kind !== "combo") return;
    expect(result.candidates.map((model) => model.modelId)).toEqual(["a", "b"]);
  });

  test("terminates alias loops and collapses nested combos", () => {
    const loop: ModelReferenceConfig = {
      prefixes: new Map(),
      aliases: new Map([
        ["a", "b"],
        ["b", "a"],
      ]),
      combos: new Map(),
    };
    expect(resolveModelChain("a", loop)).toEqual({ kind: "unresolved" });

    const empty: ComboDefinition = { id: "empty", models: ["self"], strategy: "round-robin", stickyLimit: 0 };
    expect(expandCombo(empty, () => ({ kind: "unresolved" }), null)).toEqual([]);
  });
});
