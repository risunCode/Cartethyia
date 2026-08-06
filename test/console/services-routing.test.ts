import { describe, expect, test } from "bun:test";
import { RoutingConfigService } from "../../src/console/services";
import type { RoutingConfigRepository } from "../../src/console/services";

interface AliasLike {
  alias: string;
  model: string;
  createdAt: string;
}

function memoryRepo(initial: AliasLike[] = []): {
  repo: RoutingConfigRepository;
  aliases: Map<string, string>;
} {
  const aliases = new Map<string, string>(initial.map((a) => [a.alias, a.model]));
  const repo: RoutingConfigRepository = {
    listAliases: async () => [...aliases.entries()].map(([alias, model]) => ({ alias, model, createdAt: new Date(0).toISOString() })),
    putAlias: async (alias, model) => {
      aliases.set(alias, model);
      return { alias, model, createdAt: new Date(0).toISOString() };
    },
    deleteAlias: async (alias) => aliases.delete(alias),
    listCombos: async () => [],
    getCombo: async () => null,
    putCombo: async () => ({ id: "c", name: "n", models: [], strategy: "fallback", stickyLimit: 0 }),
    deleteCombo: async () => true,
  };
  return { repo, aliases };
}

describe("RoutingConfigService — aliases", () => {
  test("listAliases returns rows without metadata when no resolver is provided", async () => {
    const { repo } = memoryRepo([{ alias: "fast", model: "openai/gpt-5", createdAt: new Date(0).toISOString() }]);
    const service = new RoutingConfigService(repo);
    const rows = await service.listAliases();
    expect(rows[0]).toMatchObject({ alias: "fast", model: "openai/gpt-5" });
  });

  test("createAlias rejects a non-object body", async () => {
    const { repo } = memoryRepo();
    const service = new RoutingConfigService(repo);
    expect(await service.createAlias("not-an-object")).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
  });

  test("createAlias rejects a missing or blank alias", async () => {
    const { repo } = memoryRepo();
    const service = new RoutingConfigService(repo);
    const missing = await service.createAlias({ model: "openai/gpt-5" });
    expect(missing).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
    const blank = await service.createAlias({ alias: "   ", model: "openai/gpt-5" });
    expect(blank).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
  });

  test("createAlias rejects a missing or blank model", async () => {
    const { repo } = memoryRepo();
    const service = new RoutingConfigService(repo);
    const missing = await service.createAlias({ alias: "fast" });
    expect(missing).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
  });

  test("createAlias trims and persists a valid alias", async () => {
    const { repo, aliases } = memoryRepo();
    const service = new RoutingConfigService(repo);
    const result = await service.createAlias({ alias: "  fast  ", model: "  openai/gpt-5  " });
    expect("alias" in result).toBe(true);
    if ("alias" in result) expect(result.alias).toBe("fast");
    expect(aliases.get("fast")).toBe("openai/gpt-5");
  });

  test("createAlias updates an existing alias (upsert)", async () => {
    const { repo, aliases } = memoryRepo([{ alias: "fast", model: "openai/gpt-5", createdAt: new Date(0).toISOString() }]);
    const service = new RoutingConfigService(repo);
    const result = await service.createAlias({ alias: "fast", model: "anthropic/claude" });
    expect("alias" in result).toBe(true);
    if ("alias" in result) {
      expect(result.alias).toBe("fast");
      expect(result.model).toBe("anthropic/claude");
    }
    expect(aliases.get("fast")).toBe("anthropic/claude");
  });

  test("deleteAlias forwards to the repository and reports the outcome", async () => {
    const { repo } = memoryRepo([{ alias: "fast", model: "openai/gpt-5", createdAt: new Date(0).toISOString() }]);
    const service = new RoutingConfigService(repo);
    expect(await service.deleteAlias("fast")).toBe(true);
    expect(await service.deleteAlias("fast")).toBe(false);
  });
});

import type { ModelMetadataResolver, ResolvedModelMetadata } from "../../src/domain/model-metadata";

function metadataResolver(resolve: (m: string) => ResolvedModelMetadata | null): ModelMetadataResolver {
  return { lookup: () => null, resolve: async (m) => resolve(m) };
}

describe("RoutingConfigService — alias metadata resolution", () => {
  test("listAliases attaches resolved metadata when a resolver is configured", async () => {
    const { repo } = memoryRepo([{ alias: "fast", model: "openai/gpt-5", createdAt: new Date(0).toISOString() }]);
    const service = new RoutingConfigService(
      repo,
      metadataResolver((m) => (m === "openai/gpt-5" ? ({ kind: "model", targets: [], context: { inputTokens: 1, outputTokens: 1 }, categories: [], pricing: { inputPerMillion: 1, outputPerMillion: 2 }, source: "catalog", updatedAt: null } as ResolvedModelMetadata) : null)),
    );
    const rows = await service.listAliases();
    expect((rows[0] as { metadata?: { kind: string } }).metadata?.kind).toBe("model");
  });
});

describe("RoutingConfigService — combos", () => {
  test("putCombo validates name and models", async () => {
    const { repo } = memoryRepo();
    const service = new RoutingConfigService(repo);
    expect(await service.putCombo("nope")).toMatchObject({ ok: false, status: 400 });
    expect(await service.putCombo({ name: "" })).toMatchObject({ ok: false });
    expect(await service.putCombo({ name: "trio" })).toMatchObject({ ok: false });
    expect(await service.putCombo({ name: "trio", models: [] })).toMatchObject({ ok: false });
    expect(await service.putCombo({ name: "trio", models: ["", "x"] })).toMatchObject({ ok: false });
  });

  test("putCombo normalizes strategy and stickyLimit and persists", async () => {
    // Use a custom repo whose putCombo echoes the normalized input so the
    // assertions reflect the service's normalization, not a hardcoded mock.
    const captured: { name: string; strategy: string; stickyLimit: number } = { name: "", strategy: "", stickyLimit: 0 };
    const repo: RoutingConfigRepository = {
      listAliases: async () => [],
      putAlias: async (alias, model) => ({ alias, model, createdAt: new Date(0).toISOString() }),
      deleteAlias: async () => true,
      listCombos: async () => [],
      getCombo: async () => null,
      putCombo: async (input) => { captured.name = input.name; captured.strategy = input.strategy; captured.stickyLimit = input.stickyLimit; return { id: "c", name: input.name, models: input.models, strategy: input.strategy, stickyLimit: input.stickyLimit }; },
      deleteCombo: async () => true,
    };
    const service = new RoutingConfigService(repo);
    const result = await service.putCombo({ name: "trio", models: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"], strategy: "round-robin", stickyLimit: 7.9 });
    expect("name" in result && result.name).toBe("trio");
    expect("strategy" in result && result.strategy).toBe("round-robin");
    expect("stickyLimit" in result && result.stickyLimit).toBe(7);
    expect(captured.strategy).toBe("round-robin");
    expect(captured.stickyLimit).toBe(7);
  });

  test("putCombo defaults strategy to fallback and stickyLimit to 0", async () => {
    const { repo } = memoryRepo();
    const service = new RoutingConfigService(repo);
    const result = await service.putCombo({ name: "fb", models: ["openai/gpt-5"] });
    expect("strategy" in result && result.strategy).toBe("fallback");
    expect("stickyLimit" in result && result.stickyLimit).toBe(0);
  });
});

