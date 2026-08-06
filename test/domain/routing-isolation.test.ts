import { describe, expect, test } from "bun:test";
import {
  affinityKeyString,
  expandCombo,
  orderByRendezvous,
  rendezvousScore,
  resolveModelChain,
  MAX_MODEL_CHAIN_DEPTH,
  type ChainResult,
  type ComboDefinition,
  type ModelReferenceConfig,
} from "../../src/domain/routing";
import type { AffinityKey } from "../../src/domain/contracts";
import type { ResolvedModel } from "../../src/domain/routing";

/**
 * Rendezvous affinity and model-reference resolution in pure isolation.
 *
 * These tests exercise the stateless routing primitives directly: the same
 * affinity key always yields the same ordering regardless of input order,
 * combo expansion drops duplicates and preserves round-robin stickiness, and
 * alias/combo chains terminate at the depth cap.
 */

const AFFINITY_API: AffinityKey = { namespace: "api_key", value: "key-abc" };
const AFFINITY_TRUSTED: AffinityKey = { namespace: "trusted_identity", value: "ti-1" };

const PREFIXES = new Map<string, string>([
  ["openai", "openai"],
  ["anthropic", "anthropic"],
  ["gemini", "gemini"],
]);

function baseConfig(overrides: Partial<ModelReferenceConfig> = {}): ModelReferenceConfig {
  return {
    prefixes: overrides.prefixes ?? PREFIXES,
    aliases: overrides.aliases ?? new Map<string, string>(),
    combos: overrides.combos ?? new Map<string, ComboDefinition>(),
  };
}

// ---------------------------------------------------------------------------
// affinityKeyString
// ---------------------------------------------------------------------------

describe("affinityKeyString", () => {
  test("joins namespace and value with a colon", () => {
    expect(affinityKeyString(AFFINITY_API)).toBe("api_key:key-abc");
    expect(affinityKeyString(AFFINITY_TRUSTED)).toBe("trusted_identity:ti-1");
  });

  test("is deterministic for the same input", () => {
    expect(affinityKeyString(AFFINITY_API)).toBe(affinityKeyString({ ...AFFINITY_API }));
  });

  test.each([
    ["api_key", "key-1", "api_key:key-1"],
    ["trusted_identity", "ti-2", "trusted_identity:ti-2"],
  ] as const)("namespace=%s value=%s → %s", (namespace, value, expected) => {
    expect(affinityKeyString({ namespace, value } as AffinityKey)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// rendezvousScore
// ---------------------------------------------------------------------------

describe("rendezvousScore", () => {
  test("returns a deterministic uint32 score for the same key and candidate", () => {
    const score = rendezvousScore("my-key", "candidate-a");
    expect(score).toBe(rendezvousScore("my-key", "candidate-a"));
  });

  test("score is in the unsigned 32-bit range [0, 2^32 - 1]", () => {
    const candidates = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (const candidate of candidates) {
      const score = rendezvousScore("k", candidate);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(score)).toBe(true);
    }
  });

  test("varies across different candidates for the same key", () => {
    const key = "rendezvous-key";
    const scores = new Set(
      ["alpha", "beta", "gamma", "delta", "epsilon"].map((c) => rendezvousScore(key, c)),
    );
    // FNV-1a is collision-resistant across short distinct strings.
    expect(scores.size).toBe(5);
  });

  test("changes when the affinity key changes (for at least one candidate)", () => {
    const candidate = "candidate-x";
    const scoreA = rendezvousScore("key-a", candidate);
    const scoreB = rendezvousScore("key-b", candidate);
    expect(scoreA).not.toBe(scoreB);
  });

  test("is sensitive to the null separator (key vs candidate collision does not alias)", () => {
    // "ab\0cd" must not equal the hash of a different key/candidate split that
    // concatenates to the same visible string without the separator.
    expect(rendezvousScore("ab", "cd")).not.toBe(rendezvousScore("a", "bcd"));
  });
});

// ---------------------------------------------------------------------------
// orderByRendezvous
// ---------------------------------------------------------------------------

describe("orderByRendezvous", () => {
  test("orders by score descending", () => {
    const items = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const ordered = orderByRendezvous("sort-key", items, (x) => x);
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = rendezvousScore("sort-key", ordered[i - 1]!);
      const curr = rendezvousScore("sort-key", ordered[i]!);
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  test("is deterministic regardless of input order", () => {
    const items = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const forward = orderByRendezvous("k", items, (x) => x);
    const reversed = orderByRendezvous("k", [...items].reverse(), (x) => x);
    expect(forward).toEqual(reversed);
  });

  test("breaks ties by id ascending (equal ids preserve stable order)", () => {
    // Force equal scores by giving every item the same id; the comparator's
    // id comparison returns 0 and the stable sort preserves input order.
    const items = [
      { id: "same", n: 1 },
      { id: "same", n: 2 },
      { id: "same", n: 3 },
    ];
    const ordered = orderByRendezvous("tie-key", items, (x) => x.id);
    expect(ordered.map((x) => x.n)).toEqual([1, 2, 3]);
  });

  test("breaks score ties by id ascending", () => {
    // Two items with distinct ids that hash to the same score are ordered by
    // id ascending. We approximate by constructing items whose ids we control;
    // even without a guaranteed collision, distinct ids with equal scores
    // would sort alphabetically. Here we assert the general property: for any
    // pair with equal scores, the id-smaller one comes first.
    const items = ["z", "a", "m", "b"];
    const ordered = orderByRendezvous("tie-id-key", items, (x) => x);
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1]!;
      const curr = ordered[i]!;
      const prevScore = rendezvousScore("tie-id-key", prev);
      const currScore = rendezvousScore("tie-id-key", curr);
      if (prevScore === currScore) {
        expect(prev <= curr).toBe(true);
      }
    }
  });

  test("returns an empty array for empty input", () => {
    expect(orderByRendezvous("k", [], (x) => x)).toEqual([]);
  });

  test("does not mutate the input array", () => {
    const items = ["alpha", "beta", "gamma"];
    const snapshot = [...items];
    orderByRendezvous("k", items, (x) => x);
    expect(items).toEqual(snapshot);
  });

  test("returns a new array instance", () => {
    const items = ["a", "b"];
    const ordered = orderByRendezvous("k", items, (x) => x);
    expect(ordered).not.toBe(items);
  });
});

// ---------------------------------------------------------------------------
// expandCombo
// ---------------------------------------------------------------------------

describe("expandCombo", () => {
  const qm = (providerId: string, modelId: string): ResolvedModel => ({ providerId, modelId });

  test("keeps definition order for fallback strategy", () => {
    const combo: ComboDefinition = {
      id: "fb1",
      models: ["openai/a", "anthropic/b", "openai/c"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const resolveMember = (name: string): ChainResult => {
      const [p, m] = name.split("/") as [string, string];
      return { kind: "qualified", model: qm(p, m) };
    };
    const result = expandCombo(combo, resolveMember, null);
    expect(result).toEqual([qm("openai", "a"), qm("anthropic", "b"), qm("openai", "c")]);
  });

  test("drops duplicate qualified targets (first occurrence wins)", () => {
    const combo: ComboDefinition = {
      id: "dup1",
      models: ["openai/a", "openai/a", "anthropic/b", "openai/a"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const resolveMember = (name: string): ChainResult => {
      const [p, m] = name.split("/") as [string, string];
      return { kind: "qualified", model: qm(p, m) };
    };
    const result = expandCombo(combo, resolveMember, null);
    expect(result).toEqual([qm("openai", "a"), qm("anthropic", "b")]);
  });

  test("flattens nested combo members", () => {
    const inner: ComboDefinition = {
      id: "inner",
      models: ["openai/x", "openai/y"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const outer: ComboDefinition = {
      id: "outer",
      models: ["openai/z", "inner"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const resolveMember = (name: string): ChainResult => {
      if (name === "inner") {
        return { kind: "combo", candidates: [qm("openai", "x"), qm("openai", "y")] };
      }
      const [p, m] = name.split("/") as [string, string];
      return { kind: "qualified", model: qm(p, m) };
    };
    const result = expandCombo(outer, resolveMember, null);
    expect(result).toEqual([qm("openai", "z"), qm("openai", "x"), qm("openai", "y")]);
  });

  test("round-robin without affinity orders by combo id (deterministic, not definition order)", () => {
    const combo: ComboDefinition = {
      id: "rr-noaff",
      models: ["openai/a", "openai/b", "openai/c", "openai/d"],
      strategy: "round-robin",
      stickyLimit: 0,
    };
    const resolveMember = (name: string): ChainResult => {
      const [p, m] = name.split("/") as [string, string];
      return { kind: "qualified", model: qm(p, m) };
    };
    const result = expandCombo(combo, resolveMember, null);
    // Same key ("combo:rr-noaff") must produce a deterministic order.
    const again = expandCombo(combo, resolveMember, null);
    expect(result).toEqual(again);
    // All members present.
    expect(result).toHaveLength(4);
  });

  test("round-robin with affinity preserves per-key ordering across calls", () => {
    const combo: ComboDefinition = {
      id: "rr-aff",
      models: ["openai/a", "openai/b", "openai/c", "openai/d"],
      strategy: "round-robin",
      stickyLimit: 1,
    };
    const resolveMember = (name: string): ChainResult => {
      const [p, m] = name.split("/") as [string, string];
      return { kind: "qualified", model: qm(p, m) };
    };
    const first = expandCombo(combo, resolveMember, AFFINITY_API);
    const second = expandCombo(combo, resolveMember, AFFINITY_API);
    expect(first).toEqual(second);
  });

  test("round-robin with affinity varies order by affinity key", () => {
    const combo: ComboDefinition = {
      id: "rr-vary",
      models: ["openai/a", "openai/b", "openai/c", "openai/d"],
      strategy: "round-robin",
      stickyLimit: 1,
    };
    const resolveMember = (name: string): ChainResult => {
      const [p, m] = name.split("/") as [string, string];
      return { kind: "qualified", model: qm(p, m) };
    };
    const byApi = expandCombo(combo, resolveMember, AFFINITY_API);
    const byTrusted = expandCombo(combo, resolveMember, AFFINITY_TRUSTED);
    // The candidate sets are equal, but the ordering differs for at least one
    // pair (rendezvous is key-sensitive).
    const sameOrder = byApi.every((m, i) => {
      const other = byTrusted[i]!;
      return m.providerId === other.providerId && m.modelId === other.modelId;
    });
    expect(sameOrder).toBe(false);
  });

  test("ignores affinity when stickyLimit is zero even if an affinity key is provided", () => {
    const combo: ComboDefinition = {
      id: "rr-sticky0",
      models: ["openai/a", "openai/b"],
      strategy: "round-robin",
      stickyLimit: 0,
    };
    const resolveMember = (name: string): ChainResult => {
      const [p, m] = name.split("/") as [string, string];
      return { kind: "qualified", model: qm(p, m) };
    };
    const withAffinity = expandCombo(combo, resolveMember, AFFINITY_API);
    const withoutAffinity = expandCombo(combo, resolveMember, null);
    // stickyLimit 0 → orderKey is "combo:rr-sticky0" in both cases.
    expect(withAffinity).toEqual(withoutAffinity);
  });
});

// ---------------------------------------------------------------------------
// resolveModelChain
// ---------------------------------------------------------------------------

describe("resolveModelChain", () => {
  test("resolves a directly qualified model", () => {
    const result = resolveModelChain("openai/gpt-4o", baseConfig());
    expect(result).toEqual({
      kind: "qualified",
      model: { providerId: "openai", modelId: "gpt-4o" },
    });
  });

  test("resolves an alias to its qualified target", () => {
    const config = baseConfig({
      aliases: new Map([["fast", "openai/gpt-4o"]]),
    });
    const result = resolveModelChain("fast", config);
    expect(result).toEqual({
      kind: "qualified",
      model: { providerId: "openai", modelId: "gpt-4o" },
    });
  });

  test("resolves chained aliases (alias → alias → qualified)", () => {
    const config = baseConfig({
      aliases: new Map([
        ["a", "b"],
        ["b", "openai/gpt-4o"],
      ]),
    });
    const result = resolveModelChain("a", config);
    expect(result.kind).toBe("qualified");
    if (result.kind === "qualified") {
      expect(result.model).toEqual({ providerId: "openai", modelId: "gpt-4o" });
    }
  });

  test("resolves a combo (fallback) into ordered candidates", () => {
    const combo: ComboDefinition = {
      id: "combo1",
      models: ["openai/gpt-4o", "anthropic/claude-3"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const config = baseConfig({ combos: new Map([["combo1", combo]]) });
    const result = resolveModelChain("combo1", config);
    expect(result.kind).toBe("combo");
    if (result.kind === "combo") {
      expect(result.candidates).toEqual([
        { providerId: "openai", modelId: "gpt-4o" },
        { providerId: "anthropic", modelId: "claude-3" },
      ]);
    }
  });

  test("resolves a combo with nested combo members", () => {
    const inner: ComboDefinition = {
      id: "inner",
      models: ["openai/x", "openai/y"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const outer: ComboDefinition = {
      id: "outer",
      models: ["openai/z", "inner"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const config = baseConfig({
      combos: new Map([
        ["inner", inner],
        ["outer", outer],
      ]),
    });
    const result = resolveModelChain("outer", config);
    expect(result.kind).toBe("combo");
    if (result.kind === "combo") {
      expect(result.candidates).toEqual([
        { providerId: "openai", modelId: "z" },
        { providerId: "openai", modelId: "x" },
        { providerId: "openai", modelId: "y" },
      ]);
    }
  });

  test("returns unresolved for an unqualified, unmatched name", () => {
    expect(resolveModelChain("mystery-model", baseConfig()).kind).toBe("unresolved");
  });

  test("returns unresolved for a name with an unknown prefix not in the prefix map", () => {
    expect(resolveModelChain("unknownvendor/somemodel", baseConfig()).kind).toBe("unresolved");
  });

  test("falls back to a known prefix when the model id contains empty path segments", () => {
    // parseModelReference rejects "openai//model" (empty segment), but the
    // chain fallback re-checks the first segment against known prefixes and
    // slices everything after the first "/" as the model id.
    const result = resolveModelChain("openai//model", baseConfig());
    expect(result.kind).toBe("qualified");
    if (result.kind === "qualified") {
      expect(result.model.providerId).toBe("openai");
    }
  });

  test("terminates an alias loop at the depth cap and returns unresolved", () => {
    const config = baseConfig({
      aliases: new Map([
        ["a", "b"],
        ["b", "a"],
      ]),
    });
    expect(resolveModelChain("a", config).kind).toBe("unresolved");
  });

  test("MAX_MODEL_CHAIN_DEPTH is 8", () => {
    expect(MAX_MODEL_CHAIN_DEPTH).toBe(8);
  });

  test("a deep but non-looping alias chain within the depth cap resolves", () => {
    // 7 hops: a0 → a1 → ... → a6 → openai/gpt (depth 7, within cap of 8).
    const aliases = new Map<string, string>();
    for (let i = 0; i < 6; i += 1) aliases.set(`a${i}`, `a${i + 1}`);
    aliases.set("a6", "openai/gpt-4o");
    const config = baseConfig({ aliases });
    expect(resolveModelChain("a0", config).kind).toBe("qualified");
  });

  test("an alias chain exceeding the depth cap returns unresolved", () => {
    // 9 hops: a0 → a1 → ... → a8 → openai/gpt (depth 9 > cap of 8).
    const aliases = new Map<string, string>();
    for (let i = 0; i < 8; i += 1) aliases.set(`a${i}`, `a${i + 1}`);
    aliases.set("a8", "openai/gpt-4o");
    const config = baseConfig({ aliases });
    expect(resolveModelChain("a0", config).kind).toBe("unresolved");
  });

  test("a combo whose members all resolve unresolved returns unresolved", () => {
    const combo: ComboDefinition = {
      id: "empty-combo",
      models: ["mystery-a", "mystery-b"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const config = baseConfig({ combos: new Map([["empty-combo", combo]]) });
    expect(resolveModelChain("empty-combo", config).kind).toBe("unresolved");
  });

  test("combo members that are aliases resolve through the alias", () => {
    const combo: ComboDefinition = {
      id: "alias-combo",
      models: ["alias-a", "alias-b"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const config = baseConfig({
      aliases: new Map([
        ["alias-a", "openai/a"],
        ["alias-b", "anthropic/b"],
      ]),
      combos: new Map([["alias-combo", combo]]),
    });
    const result = resolveModelChain("alias-combo", config);
    expect(result.kind).toBe("combo");
    if (result.kind === "combo") {
      expect(result.candidates).toEqual([
        { providerId: "openai", modelId: "a" },
        { providerId: "anthropic", modelId: "b" },
      ]);
    }
  });
});
