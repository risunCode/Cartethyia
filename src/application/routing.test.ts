import { describe, expect, test } from "bun:test";
import {
  MAX_MODEL_CHAIN_DEPTH,
  affinityKeyString,
  expandCombo,
  orderByRendezvous,
  parseModelReference,
  resolveModelChain,
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
    expect(orderByRendezvous(key, candidates, (candidate) => candidate.id)).toEqual(
      orderByRendezvous(key, [...candidates].reverse(), (candidate) => candidate.id),
    );
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
