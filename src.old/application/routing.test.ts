import { describe, expect, test } from "bun:test";
import {
  MAX_MODEL_CHAIN_DEPTH,
  affinityKeyString,
  createSelectionDecision,
  expandCombo,
  expandComboWithDiagnostics,
  orderByRendezvous,
  parseModelReference,
  resolveModelChain,
  resolveModelChainWithDiagnostics,
  rendezvousScore,
  type ChainResult,
  type ComboDefinition,
  type ModelReferenceConfig,
} from "./routing";

describe("model routing", () => {
  test("keeps affinity ordering deterministic and input-order independent", () => {
    const key = affinityKeyString({ namespace: "api_key", value: "key-a" });
    const candidates = [{ id: "provider-a/model" }, { id: "provider-b/model" }, { id: "provider-c/model" }];

    expect(affinityKeyString({ namespace: "trusted_identity", value: "user-1" })).toBe("trusted_identity:user-1");
    expect(rendezvousScore(key, "provider-a/model")).toBe(rendezvousScore(key, "provider-a/model"));
    expect(orderByRendezvous(key, [...candidates].reverse(), (candidate) => candidate.id)).toEqual(
      orderByRendezvous(key, candidates, (candidate) => candidate.id),
    );
  });

  test("keeps unaffected rendezvous affinity stable across pool mutation and recovery", () => {
    const key = "trusted_identity:user-1";
    const base = [{ id: "account-a" }, { id: "account-b" }, { id: "account-c" }];
    const initial = orderByRendezvous(key, base, (candidate) => candidate.id).map((candidate) => candidate.id);
    const withoutRecovered = orderByRendezvous(
      key,
      base.filter((candidate) => candidate.id !== "account-b"),
      (candidate) => candidate.id,
    ).map((candidate) => candidate.id);
    const recovered = orderByRendezvous(key, [...base], (candidate) => candidate.id).map((candidate) => candidate.id);

    expect(recovered).toEqual(initial);
    expect(withoutRecovered).toEqual(initial.filter((candidateId) => candidateId !== "account-b"));
    expect(initial.filter((candidateId) => candidateId !== "account-b")).toEqual(withoutRecovered);
  });

  test("records selection reason, affinity, and deduplicated exclusions", () => {
    expect(
      createSelectionDecision({
        candidateId: "account-a",
        reason: "sticky",
        affinityKey: { namespace: "api_key", value: "key-a" },
        excludedCandidateIds: ["account-b", "account-b", "account-a"],
      }),
    ).toEqual({
      candidateId: "account-a",
      reason: "sticky",
      affinityKey: "api_key:key-a",
      excludedCandidateIds: ["account-b"],
    });
  });

  test("parses qualified model IDs while preserving nested provider paths", () => {
    const prefixes = new Map([["blackbox", "blackboxai"]]);

    expect(parseModelReference("blackbox/z-ai/glm-5.2", prefixes)).toEqual({
      kind: "qualified",
      providerId: "blackboxai",
      modelId: "z-ai/glm-5.2",
    });
    expect(parseModelReference("glm-5.2", prefixes)).toEqual({ kind: "unqualified" });
    expect(parseModelReference("unknown/model", prefixes)).toMatchObject({ kind: "invalid" });
    expect(parseModelReference("blackbox/", prefixes)).toMatchObject({ kind: "invalid" });
  });

  test("expands aliases and combos without duplicate candidates", () => {
    const combo: ComboDefinition = {
      id: "balanced",
      models: ["primary", "fallback", "primary"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const resolveMember = (name: string): ChainResult => {
      if (name === "primary") return { kind: "qualified", model: { providerId: "openai", modelId: "gpt-5" } };
      if (name === "fallback") return { kind: "qualified", model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" } };
      return { kind: "unresolved" };
    };

    expect(expandCombo(combo, resolveMember, null)).toEqual([
      { providerId: "openai", modelId: "gpt-5" },
      { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    ]);
  });

  test("exposes unresolved combo members without changing valid sibling order", () => {
    const combo: ComboDefinition = {
      id: "partial",
      models: ["missing", "openai/gpt-5", "missing"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const detailed = expandComboWithDiagnostics(
      combo,
      (name): ChainResult =>
        name === "openai/gpt-5"
          ? { kind: "qualified", model: { providerId: "openai", modelId: "gpt-5" } }
          : { kind: "unresolved" },
      null,
    );

    expect(detailed.candidates).toEqual([{ providerId: "openai", modelId: "gpt-5" }]);
    expect(detailed.diagnostics).toHaveLength(1);
    expect(detailed.diagnostics[0]).toMatchObject({ code: "unresolved_member", member: "missing" });
  });

  test("returns nested combo cycles as unresolved when no sibling remains", () => {
    const config: ModelReferenceConfig = {
      prefixes: new Map([["openai", "openai"]]),
      aliases: new Map(),
      combos: new Map([
        ["outer", { id: "outer-id", models: ["inner"], strategy: "fallback", stickyLimit: 0 }],
        ["inner", { id: "inner-id", models: ["outer"], strategy: "fallback", stickyLimit: 0 }],
      ]),
    };

    const detailed = resolveModelChainWithDiagnostics("outer", config);

    expect(detailed.result).toEqual({ kind: "unresolved" });
    expect(detailed.diagnostics.some((diagnostic) => diagnostic.code === "cycle")).toBe(true);
    expect(detailed.diagnostics.some((diagnostic) => diagnostic.code === "empty_combo")).toBe(true);
  });

  test("keeps valid nested siblings while surfacing a cycle diagnostic", () => {
    const config: ModelReferenceConfig = {
      prefixes: new Map([["openai", "openai"]]),
      aliases: new Map(),
      combos: new Map([
        ["outer", { id: "outer-id", models: ["inner", "openai/gpt-5"], strategy: "fallback", stickyLimit: 0 }],
        ["inner", { id: "inner-id", models: ["inner"], strategy: "fallback", stickyLimit: 0 }],
      ]),
    };

    const resolved = resolveModelChain("outer", config);

    expect(resolved).toMatchObject({
      kind: "combo",
      candidates: [{ providerId: "openai", modelId: "gpt-5" }],
    });
    expect(resolved.kind === "combo" ? resolved.diagnostics?.[0]?.code : undefined).toBe("cycle");
  });

  test("terminates alias cycles instead of recursing forever", () => {
    const config: ModelReferenceConfig = {
      prefixes: new Map([["openai", "openai"]]),
      aliases: new Map([["a", "b"], ["b", "a"]]),
      combos: new Map(),
    };

    expect(resolveModelChain("a", config)).toEqual({ kind: "unresolved" });
    expect(MAX_MODEL_CHAIN_DEPTH).toBeGreaterThan(0);
  });
});
