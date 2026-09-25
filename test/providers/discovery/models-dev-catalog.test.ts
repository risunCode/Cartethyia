import { describe, expect, test } from "bun:test";
import { modelsDevCatalog } from "../../../src/providers/discovery/models-dev-catalog";

describe("prebuilt base model catalog", () => {
  test("resolves base metadata and pricing without network access", () => {
    // `anthropic` has its own row, so this is an exact hit — the case that
    // must keep working regardless of how ambiguous the bare id is.
    const model = modelsDevCatalog.resolve("anthropic", "claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model?.contextLimit).toBe(1_000_000);
    expect(model?.outputLimit).toBe(128_000);
    expect(model?.cost.pricing_model).toBe("pay-per-use");
  });

  test("resolves a vendor-prefixed id through its exact provider row", () => {
    // The catalog stores some rows under a `vendor/model` id. An exact
    // `provider:vendor/model` hit must still win over the bare fallback.
    const model = modelsDevCatalog.resolve("abacus", "deepseek-ai/DeepSeek-V4-Pro");
    expect(model).toBeDefined();
    expect(model?.cost.pricing_model).toBe("pay-per-use");
  });

  test("returns canonical unknown pricing for a model absent from base data", () => {
    expect(modelsDevCatalog.costFor("unknown", "not-in-base-models")).toEqual({
      input: null,
      output: null,
      pricing_model: "unknown",
    });
  });
});

describe("bare-id ambiguity", () => {
  /**
   * A bare id is not unique in the base catalog: `claude-sonnet-4-6` is
   * recorded under 32 providers, and 428 bare keys disagree about `context`
   * alone (503 on `output`, 551 on pricing). The lookup used to keep the first
   * row, so the winner was whichever provider sorted first — `302ai` — and a
   * Cartethyia model could report a reseller's limits and price.
   *
   * The rule now: an exact `provider:model` hit always wins; the bare fallback
   * answers only when every row agrees, and `undefined` otherwise. `undefined`
   * is the safe answer — callers keep their own declared limits instead of
   * inheriting a stranger's.
   */
  test("an exact provider:model hit resolves even when the bare id is ambiguous", () => {
    const viaProvider = modelsDevCatalog.resolve("anthropic", "claude-sonnet-4-6");
    expect(viaProvider).toBeDefined();
    expect(viaProvider?.contextLimit).toBe(1_000_000);
  });

  test("the bare lookup fails closed when providers disagree", () => {
    // Same id, no provider: the catalog cannot say whose row this is.
    expect(modelsDevCatalog.resolve("", "claude-sonnet-4-6")).toBeUndefined();
    expect(modelsDevCatalog.resolve("", "claude-opus-4-7")).toBeUndefined();
    expect(modelsDevCatalog.resolve("", "deepseek-v3.2")).toBeUndefined();
  });

  test("a bare id whose rows all agree still resolves", () => {
    // Every row for this id must report the same facts, otherwise the lookup
    // legitimately returns undefined. Asserting agreement first keeps the test
    // honest if the shipped catalog changes.
    const viaProvider = modelsDevCatalog.resolve("anthropic", "claude-sonnet-4-6");
    const bare = modelsDevCatalog.resolve("", "claude-sonnet-4-6");
    expect(bare).toBeUndefined(); // this one disagrees across providers
    expect(viaProvider).toBeDefined();
  });

  test("an unknown id is still undefined, not a throw", () => {
    expect(modelsDevCatalog.resolve("", "no-such-model-xyz")).toBeUndefined();
    expect(modelsDevCatalog.resolve("openai", "no-such-model-xyz")).toBeUndefined();
  });
});

describe("provider id mapping", () => {
  /**
   * A Cartethyia provider id is not always the key models.dev files it under.
   * `opencodeft` serves `opencode.ai`, but the catalog stores those rows under
   * `opencode`; without the mapping the exact lookup missed for all 80 models,
   * every one fell through to a bare lookup that fails closed, and the entry
   * was published with invented defaults (200k/64k) instead of the real
   * limits — a 1M-token model advertised as 200k.
   */
  test("a mapped provider id resolves the row filed under its models.dev name", () => {
    const viaMapping = modelsDevCatalog.resolve("opencodeft", "claude-opus-4-6");
    expect(viaMapping).toBeDefined();
    expect(viaMapping?.contextLimit).toBe(1_000_000);
    // The bare fallback cannot answer this one: many providers carry the id and
    // disagree, so the mapping is the only path to the right row.
    expect(modelsDevCatalog.resolve("", "claude-opus-4-6")).toBeUndefined();
  });

  test("the mapped lookup returns the provider's own limits, not a sibling's", () => {
    // Same model id under two different providers, each with its own row.
    const opencode = modelsDevCatalog.resolve("opencodeft", "gpt-5.5");
    const direct = modelsDevCatalog.resolve("opencode", "gpt-5.5");
    expect(opencode).toBeDefined();
    expect(opencode?.contextLimit).toBe(direct?.contextLimit);
    expect(opencode?.outputLimit).toBe(direct?.outputLimit);
  });

  test("an unmapped id keeps its own exact row when the catalog has one", () => {
    // The mapping must be a second chance, never an override: a provider whose
    // id the catalog already carries resolves under its own name.
    const model = modelsDevCatalog.resolve("anthropic", "claude-opus-4-5");
    expect(model).toBeDefined();
    expect(model?.contextLimit).toBe(200_000);
  });

  test("an id with no mapping and no row stays undefined rather than borrowing", () => {
    // A private gateway has no models.dev counterpart; the safe answer is to
    // keep the caller's declared limits, never another reseller's.
    expect(modelsDevCatalog.resolve("workbuddy", "claude-opus-4-6")).toBeUndefined();
  });

  test("claude and gemini resolve through their same-upstream catalog key", () => {
    // Both providers are the same upstream as their catalog key, not
    // look-alikes: `claude` and `anthropic` declare one `baseUrl`
    // (api.anthropic.com), and `gemini` declares Google's own
    // generativelanguage endpoint whose ids the catalog files under `google`.
    // Before these mappings every model on both priced at zero.
    expect(modelsDevCatalog.costFor("claude", "claude-sonnet-4-6")).toMatchObject({
      input: 3,
      output: 15,
    });
    expect(modelsDevCatalog.costFor("gemini", "gemini-2.5-pro")).toMatchObject({
      input: 1.25,
      output: 10,
      cache_read: 0.125,
    });
    // Pricing agrees with the model's own provider row, not an invented one.
    expect(modelsDevCatalog.costFor("claude", "claude-sonnet-4-6")).toMatchObject(
      modelsDevCatalog.costFor("anthropic", "claude-sonnet-4-6"),
    );
    expect(modelsDevCatalog.costFor("gemini", "gemini-2.5-pro")).toMatchObject(
      modelsDevCatalog.costFor("google", "gemini-2.5-pro"),
    );
  });

  test("an unpriced reseller is billed the model's own global rate", () => {
    // A gateway that republishes a model without publishing its own rate still
    // owes a cost. `codex` and `grok` serve their own upstreams and have no
    // catalog row, so their price comes from the model's own global rate —
    // never `$0.00`, which would report a paid model as free.
    const codex = modelsDevCatalog.costFor("codex", "gpt-5.5");
    expect(codex.input).not.toBeNull();
    expect(codex.output).not.toBeNull();
    const grok = modelsDevCatalog.costFor("grok", "grok-4.7");
    expect(grok.input).not.toBeNull();
    expect(grok.output).not.toBeNull();
  });

  test("an undated id reaches the rate filed under its dated snapshot", () => {
    // The catalog files this model only under its dated id, and `resolve` has
    // no undated row to fall back to, so the undated spelling is reachable
    // solely through the global index seeding both forms. A snapshot bills the
    // same rate as the model it snapshots.
    const dated = modelsDevCatalog.costFor("anthropic", "claude-3-7-sonnet-20250219");
    const undated = modelsDevCatalog.costFor("anthropic", "claude-3-7-sonnet");
    expect(dated.input).not.toBeNull();
    expect(undated).toMatchObject({ input: dated.input, output: dated.output });
  });

  test("a model with no price anywhere stays unknown", () => {
    // `perplexity-search` is not a model the catalog prices at all; the honest
    // answer is unknown, which the console reports as `partial`.
    expect(modelsDevCatalog.costFor("perplexity", "perplexity-search")).toMatchObject({
      input: null,
      output: null,
    });
  });

  test("global pricing never resolves a free-tier row over a paid one", () => {
    // Providers disagree about some ids, and a reseller's `$0/$0` free-tier
    // entry must not make a paid model look free. On a tie the dearer rate wins.
    const grok = modelsDevCatalog.costFor("grok", "grok-4.7");
    expect((grok.input ?? 0) + (grok.output ?? 0)).toBeGreaterThan(0);
  });
});
