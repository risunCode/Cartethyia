import { describe, expect, test } from "bun:test";
import type { AffinityKey } from "../../src/application/contracts";
import {
  affinityKeyString,
  createSelectionDecision,
  expandCombo,
  expandComboWithDiagnostics,
  MAX_MODEL_CHAIN_DEPTH,
  orderByRendezvous,
  parseModelReference,
  resolveAlias,
  resolveModelChain,
  resolveModelChainWithDiagnostics,
  rendezvousScore,
  type ChainResult,
  type ComboDefinition,
  type ModelChainResolution,
  type ModelReferenceConfig,
} from "../../src/application/routing";

const prefixes = new Map([
  ["openai", "openai"],
  ["anthropic", "anthropic"],
  ["vertex", "google"],
]);

function referenceConfig(
  aliases: ReadonlyMap<string, string> = new Map(),
  combos: ReadonlyMap<string, ComboDefinition> = new Map(),
): ModelReferenceConfig {
  return { prefixes, aliases, combos };
}

function modelIds(result: ChainResult): string[] {
  if (result.kind === "qualified") return [`${result.model.providerId}/${result.model.modelId}`];
  if (result.kind === "combo") return result.candidates.map((model) => `${model.providerId}/${model.modelId}`);
  return [];
}

describe("routing hot paths", () => {
  test("parses qualified, unqualified, and invalid references and follows alias chains", () => {
    expect(affinityKeyString({ namespace: "api_key", value: "key-a" })).toBe("api_key:key-a");
    expect(parseModelReference("openai/gpt-5.4/mini", prefixes)).toEqual({
      kind: "qualified",
      providerId: "openai",
      modelId: "gpt-5.4/mini",
    });
    expect(parseModelReference("gpt-5.4", prefixes)).toEqual({ kind: "unqualified" });
    expect(parseModelReference("unknown/gpt-5", prefixes)).toEqual({
      kind: "invalid",
      reason: 'Unknown provider prefix "unknown".',
    });
    expect(parseModelReference("/gpt-5", prefixes)).toEqual({
      kind: "invalid",
      reason: "Provider-qualified model names must include both a provider prefix and a model ID.",
    });

    const aliases = new Map([
      ["fast", "openai/gpt-5.4"],
      ["default", "fast"],
    ]);
    const config = referenceConfig(aliases);

    expect(resolveAlias("fast", aliases)).toBe("openai/gpt-5.4");
    expect(resolveAlias("missing", aliases)).toBeNull();
    expect(resolveModelChain("openai/gpt-5.4", config)).toEqual({
      kind: "qualified",
      model: { providerId: "openai", modelId: "gpt-5.4" },
    });
    expect(resolveModelChain("default", config)).toEqual({
      kind: "qualified",
      model: { providerId: "openai", modelId: "gpt-5.4" },
    });
  });

  test("keeps fallback order while flattening nested combos and deduplicating targets", () => {
    const inner: ComboDefinition = {
      id: "inner-combo",
      models: ["openai/alpha", "backup", "openai/alpha"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const outer: ComboDefinition = {
      id: "outer-combo",
      models: ["inner-alias", "openai/beta", "inner"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const originalOuterModels = [...outer.models];
    const config = referenceConfig(
      new Map([
        ["inner-alias", "inner"],
        ["backup", "anthropic/claude-sonnet-4-5"],
      ]),
      new Map([
        ["inner", inner],
        ["outer", outer],
      ]),
    );

    const resolved = resolveModelChain("outer", config);
    expect(modelIds(resolved)).toEqual([
      "openai/alpha",
      "anthropic/claude-sonnet-4-5",
      "openai/beta",
    ]);
    expect(outer.models).toEqual(originalOuterModels);
    expect(resolveModelChainWithDiagnostics("outer", config)).toEqual({
      result: resolved,
      diagnostics: [],
    });

    const legacy = expandCombo(
      {
        id: "legacy",
        models: ["openai/alpha"],
        strategy: "fallback",
        stickyLimit: 0,
      },
      (name): ChainResult => ({
        kind: "qualified",
        model: { providerId: "openai", modelId: name.split("/")[1] ?? name },
      }),
      null,
    );
    expect(legacy).toEqual([{ providerId: "openai", modelId: "alpha" }]);
  });

  test("orders round-robin combos by combo identity without affinity and by sticky affinity when enabled", () => {
    const modelNames = ["openai/alpha", "openai/beta", "openai/gamma", "openai/delta"];
    const noStickyCombo: ComboDefinition = {
      id: "rotator",
      models: modelNames,
      strategy: "round-robin",
      stickyLimit: 0,
    };
    const stickyCombo: ComboDefinition = { ...noStickyCombo, stickyLimit: 2 };
    const noStickyConfig = referenceConfig(new Map(), new Map([[noStickyCombo.id, noStickyCombo]]));
    const stickyConfig = referenceConfig(new Map(), new Map([[stickyCombo.id, stickyCombo]]));
    const apiAffinity: AffinityKey = { namespace: "api_key", value: "client-1" };
    const identityAffinity: AffinityKey = { namespace: "trusted_identity", value: "client-1" };

    expect(modelIds(resolveModelChain("rotator", noStickyConfig))).toEqual([
      "openai/beta",
      "openai/alpha",
      "openai/gamma",
      "openai/delta",
    ]);
    expect(modelIds(resolveModelChain("rotator", noStickyConfig, apiAffinity))).toEqual(
      modelIds(resolveModelChain("rotator", noStickyConfig)),
    );
    expect(modelIds(resolveModelChain("rotator", stickyConfig))).toEqual([
      "openai/beta",
      "openai/alpha",
      "openai/gamma",
      "openai/delta",
    ]);
    expect(modelIds(resolveModelChain("rotator", stickyConfig, apiAffinity))).toEqual([
      "openai/beta",
      "openai/alpha",
      "openai/delta",
      "openai/gamma",
    ]);
    expect(modelIds(resolveModelChain("rotator", stickyConfig, identityAffinity))).toEqual([
      "openai/delta",
      "openai/alpha",
      "openai/beta",
      "openai/gamma",
    ]);
  });

  test("keeps rendezvous ordering deterministic across input order and pool mutation, including ties", () => {
    const key = "trusted_identity:user-1";
    const pool = [{ id: "account-a" }, { id: "account-b" }, { id: "account-c" }];
    const initial = orderByRendezvous(key, pool, (candidate) => candidate.id).map((candidate) => candidate.id);
    const reversed = orderByRendezvous(key, [...pool].reverse(), (candidate) => candidate.id).map((candidate) => candidate.id);
    const withoutAccountB = orderByRendezvous(
      key,
      pool.filter((candidate) => candidate.id !== "account-b"),
      (candidate) => candidate.id,
    ).map((candidate) => candidate.id);
    const recovered = orderByRendezvous(key, [...pool], (candidate) => candidate.id).map((candidate) => candidate.id);

    expect(reversed).toEqual(initial);
    expect(withoutAccountB).toEqual(initial.filter((candidateId) => candidateId !== "account-b"));
    expect(recovered).toEqual(initial);
    expect(pool.map((candidate) => candidate.id)).toEqual(["account-a", "account-b", "account-c"]);

    const tieKey = "tie";
    const firstTieId = "c3b9cc";
    const secondTieId = "ce2b18";
    expect(rendezvousScore(tieKey, firstTieId)).toBe(rendezvousScore(tieKey, secondTieId));
    expect(
      orderByRendezvous(
        tieKey,
        [{ id: secondTieId }, { id: firstTieId }],
        (candidate) => candidate.id,
      ).map((candidate) => candidate.id),
    ).toEqual([firstTieId, secondTieId]);
  });

  test("flattens diagnostic combo results, preserves valid siblings, and bounds repeated diagnostics", () => {
    const nestedDiagnostic = { code: "unknown_reference" as const, path: ["nested", "missing"] };
    const directDiagnostic = { code: "unknown_reference" as const, path: ["missing"] };
    const combo: ComboDefinition = {
      id: "partial",
      models: ["good", "nested", "missing", "good"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const resolveMember = (name: string): ChainResult | ModelChainResolution => {
      if (name === "good") {
        return { kind: "qualified", model: { providerId: "openai", modelId: "gpt-5" } };
      }
      if (name === "nested") {
        return {
          result: {
            kind: "combo",
            candidates: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }],
          },
          diagnostics: [nestedDiagnostic],
        };
      }
      return { result: { kind: "unresolved" }, diagnostics: [directDiagnostic] };
    };

    const detailed = expandComboWithDiagnostics(combo, resolveMember, null);
    expect(detailed.candidates).toEqual([
      { providerId: "openai", modelId: "gpt-5" },
      { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    ]);
    expect(detailed.diagnostics).toEqual([nestedDiagnostic, directDiagnostic]);

    const manyMissing: ComboDefinition = {
      id: "many-missing",
      models: Array.from({ length: 40 }, (_, index) => `missing-${index}`),
      strategy: "fallback",
      stickyLimit: 0,
    };
    const bounded = expandComboWithDiagnostics(manyMissing, () => ({ kind: "unresolved" }), null);
    expect(bounded.candidates).toEqual([]);
    expect(bounded.diagnostics).toHaveLength(32);
    expect(new Set(bounded.diagnostics.map((diagnostic) => diagnostic.member)).size).toBe(32);
  });

  test("returns explicit cycle and empty-combo diagnostics and stops at alias and combo depth caps", () => {
    const cyclicConfig = referenceConfig(
      new Map(),
      new Map([
        ["outer", { id: "outer", models: ["inner"], strategy: "fallback", stickyLimit: 0 }],
        ["inner", { id: "inner", models: ["outer"], strategy: "fallback", stickyLimit: 0 }],
      ]),
    );
    const cyclic = resolveModelChainWithDiagnostics("outer", cyclicConfig);
    expect(cyclic.result).toEqual({ kind: "unresolved" });
    expect(cyclic.diagnostics).toContainEqual({ code: "cycle", path: ["outer", "inner", "outer"] });
    expect(cyclic.diagnostics.some((diagnostic) => diagnostic.code === "empty_combo")).toBe(true);

    const deepAliases = new Map<string, string>();
    for (let index = 0; index <= MAX_MODEL_CHAIN_DEPTH; index += 1) {
      deepAliases.set(`alias-${index}`, `alias-${index + 1}`);
    }
    deepAliases.set(`alias-${MAX_MODEL_CHAIN_DEPTH + 1}`, "openai/too-deep");
    const deepAliasResult = resolveModelChainWithDiagnostics("alias-0", referenceConfig(deepAliases));
    expect(deepAliasResult.result).toEqual({ kind: "unresolved" });
    expect(deepAliasResult.diagnostics).toContainEqual({ code: "unknown_reference", path: ["alias-0"] });

    const deepCombos = new Map<string, ComboDefinition>();
    for (let index = 0; index < MAX_MODEL_CHAIN_DEPTH; index += 1) {
      deepCombos.set(`depth-combo-${index}`, {
        id: `depth-combo-${index}`,
        models: index === MAX_MODEL_CHAIN_DEPTH - 1 ? ["openai/never-reached"] : [`depth-combo-${index + 1}`],
        strategy: "fallback",
        stickyLimit: 0,
      });
    }
    const comboDepthResult = resolveModelChainWithDiagnostics(
      "depth-combo-0",
      referenceConfig(new Map(), deepCombos),
    );
    expect(comboDepthResult.result).toEqual({ kind: "unresolved" });
    expect(comboDepthResult.diagnostics).toContainEqual({
      code: "max_depth",
      comboId: "depth-combo-7",
      path: [
        "depth-combo-0",
        "depth-combo-1",
        "depth-combo-2",
        "depth-combo-3",
        "depth-combo-4",
        "depth-combo-5",
        "depth-combo-6",
        "depth-combo-7",
      ],
    });
  });

  test("records selection metadata with normalized affinity and bounded exclusions", () => {
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
    expect(
      createSelectionDecision({
        candidateId: "route-a",
        reason: "fallback",
        affinityKey: "trusted_identity:user-1",
        excludedCandidateIds: ["route-b", "route-b"],
      }),
    ).toEqual({
      candidateId: "route-a",
      reason: "fallback",
      affinityKey: "trusted_identity:user-1",
      excludedCandidateIds: ["route-b"],
    });
    expect(
      createSelectionDecision({ candidateId: "route-c", reason: "preferred", affinityKey: null }),
    ).toEqual({ candidateId: "route-c", reason: "preferred", excludedCandidateIds: [] });
  });
});
