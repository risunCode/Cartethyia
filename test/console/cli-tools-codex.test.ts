import { describe, expect, test } from "bun:test";
import { TOOL_REGISTRY } from "../../src/console/cli-tools/registry";
import { codexInjector } from "../../src/console/cli-tools/injectors/codex";
import { tomlRemoveSection, tomlRemoveSectionFlat, tomlUpsertRootFlat, tomlUpsertSectionFlat } from "../../src/console/cli-tools/fs-ops";

describe("Codex CLI routing contract", () => {
  test("uses current Codex session, subagent, and review roles", () => {
    const codex = TOOL_REGISTRY.codex;
    expect("defaultMappingTarget" in codex).toBe(false);
    expect(codex.defaultModels.map((model) => model.alias)).toEqual(["session", "subagent", "review"]);
    expect("mappingMode" in codex).toBe(false);
    expect("mappingSupported" in codex).toBe(false);
    expect(codex.defaultModels.map((model) => model.defaultValue)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.3-codex-spark",
      "gpt-5.6-terra",
    ]);
  });

  test("preserves sibling agents settings while upserting the official subagent key", () => {
    const original = "[agents]\nmax_concurrent_threads_per_session = 8\n\n[profiles.fast]\nmodel = \"gpt-5.6-luna\"\n";
    const next = tomlUpsertSectionFlat(original, "agents", "default_subagent_model", "kimchi/deepseek-v4-flash");
    expect(next).toContain("max_concurrent_threads_per_session = 8");
    expect(next).toContain("default_subagent_model = \"kimchi/deepseek-v4-flash\"");
    expect(next).toContain("[profiles.fast]");
    expect(tomlRemoveSectionFlat(next, "agents", "default_subagent_model")).not.toContain("default_subagent_model");
  });

  test("repairs legacy inline agents headers without merging the next table", () => {
    const original = "[agents]  default_subagent_model = \"old\"[model_providers.cartethyia.auth]\n  timeout_ms = 1000\n";
    const next = tomlUpsertSectionFlat(original, "agents", "default_subagent_model", "new");
    expect(next).toContain("[agents]\n  default_subagent_model = \"new\"\n[model_providers.cartethyia.auth]");
  });

  test("removes duplicate provider auth tables before rewriting them", () => {
    const original = "[model_providers.cartethyia.auth]\n  timeout_ms = 1000\n\n[model_providers.cartethyia.auth]\n  timeout_ms = 2000\n";
    expect(tomlRemoveSection(original, "model_providers.cartethyia.auth")).not.toContain("[model_providers.cartethyia.auth]");
  });
  test("writes root Codex keys before tables", () => {
    const original = "[tui.model_availability_nux]\n\"gpt-5.6-sol\" = 1\n";
    const next = tomlUpsertRootFlat(original, "review_model", "gpt-5.6-terra");
    expect(next.indexOf("review_model = \"gpt-5.6-terra\"")).toBeLessThan(next.indexOf("[tui.model_availability_nux]"));
  });

  test("downloads a config using Codex's current [agents] schema", async () => {
    const result = await codexInjector.download({
      endpoint: "http://127.0.0.1:12800",
      apiKey: "cartethyia-test-key",
      models: ["gpt-5.6-sol"],
      modelSlots: { session: "gpt-5.6-sol", subagent: "gpt-5.3-codex-spark", review: "gpt-5.6-terra" },
      activeModel: "gpt-5.6-sol",
      subagentModel: "gpt-5.3-codex-spark",
      mapping: { enabled: true, mappings: [{ slotKey: "session", sourceModel: "gpt-5.6-sol", targetModel: "kimchi/deepseek-v4-flash", enabled: true }] },
    });
    expect(result.content).toContain("review_model = \"gpt-5.6-terra\"");
    expect(result.content).toContain("[model_providers.cartethyia.auth]");
    expect(result.content).toContain("refresh_interval_ms = 0");
    expect(result.content).toContain("cartethyia-auth.cjs");
    expect(result.content).toContain("[agents]");
    expect(result.content).toContain("default_subagent_model = \"gpt-5.3-codex-spark\"");
    expect(result.content).not.toContain("[agents.subagent]");
  });
});
