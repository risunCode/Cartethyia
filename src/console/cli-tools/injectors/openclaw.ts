import type {} from "../contracts";
import { ensureV1Suffix, homeDir, join, readJsonFile, writeJsonFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Open Claw injector spec.
function resolveOpenclawModel(m: unknown): string {
  if (typeof m === "string") return m;
  if (m !== null && typeof m === "object" && "primary" in m) {
    return (m as { primary: string }).primary;
  }
  return "";
}

export const openclawSpec: InjectorSpec = {
  toolId: "openclaw",
  displayName: "Open Claw",
  binary: "openclaw",
  resolvePath: () => join(homeDir(), ".openclaw", "openclaw.json"),
  resolveDir: () => join(homeDir(), ".openclaw"),

  async readStatus(path) {
    const settings = (await readJsonFile(path)) as {
      models?: {
        providers?: Record<
          string,
          { baseUrl?: string; apiKey?: string; models?: Array<{ id: string }> }
        >;
      };
      agents?: { defaults?: { model?: { primary?: string } | string } };
    } | null;
    if (!settings) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const provider = settings.models?.providers?.cartethyia;
    const primaryModel = resolveOpenclawModel(settings.agents?.defaults?.model);
    return {
      configured: !!provider,
      currentEndpoint: provider?.baseUrl ?? null,
      rawApiKey: provider?.apiKey ?? null,
      currentModels: primaryModel ? [primaryModel] : (provider?.models?.map((m) => m.id) ?? null),
    };
  },

  async apply(input, path) {
    const settings = ((await readJsonFile(path)) as Record<string, unknown> | null) ?? {};

    if (typeof settings.models !== "object" || settings.models === null) settings.models = {};
    const models = settings.models as Record<string, unknown>;
    if (typeof models.providers !== "object" || models.providers === null) models.providers = {};
    const providers = models.providers as Record<string, unknown>;

    if (typeof settings.agents !== "object" || settings.agents === null) settings.agents = {};
    const agents = settings.agents as Record<string, unknown>;
    if (typeof agents.defaults !== "object" || agents.defaults === null) agents.defaults = {};
    const defaults = agents.defaults as Record<string, unknown>;
    if (typeof defaults.model !== "object" || defaults.model === null) defaults.model = {};
    if (typeof defaults.models !== "object" || defaults.models === null) defaults.models = {};

    const baseUrl = ensureV1Suffix(input.endpoint);
    const allModels = [
      ...new Set([...input.modelIds, ...(input.activeModel ? [input.activeModel] : [])]),
    ];

    const defaultModels = defaults.models as Record<string, unknown>;
    for (const key of Object.keys(defaultModels)) {
      if (key.startsWith("cartethyia/")) delete defaultModels[key];
    }

    (defaults.model as { primary: string }).primary =
      `cartethyia/${input.activeModel ?? input.modelIds[0] ?? ""}`;

    for (const m of allModels) defaultModels[`cartethyia/${m}`] = {};

    providers.cartethyia = {
      baseUrl,
      apiKey: input.apiKey,
      api: "openai-completions",
      models: allModels.map((m) => ({ id: m, name: m.split("/").pop() ?? m })),
    };

    if (Array.isArray(agents.list)) {
      agents.list = (agents.list as Array<Record<string, unknown>>).map((agent) => {
        if (resolveOpenclawModel(agent.model).startsWith("cartethyia/")) {
          const { model: _m, ...rest } = agent;
          void _m;
          return rest;
        }
        return agent;
      });
    }

    await writeJsonFile(path, settings);
  },

  async reset(path) {
    const settings = (await readJsonFile(path)) as {
      models?: { providers?: Record<string, unknown> };
      agents?: {
        defaults?: { model?: { primary?: string } | string; models?: Record<string, unknown> };
      };
    } | null;
    if (!settings) return false;

    delete settings.models?.providers?.cartethyia;

    const defaultModels = settings.agents?.defaults?.models;
    if (defaultModels) {
      for (const key of Object.keys(defaultModels)) {
        if (key.startsWith("cartethyia/")) delete defaultModels[key];
      }
    }

    const primary = resolveOpenclawModel(settings.agents?.defaults?.model);
    if (primary.startsWith("cartethyia/")) {
      if (settings.agents?.defaults?.model && typeof settings.agents.defaults.model === "object") {
        (settings.agents.defaults.model as { primary: string }).primary = "";
      }
    }

    await writeJsonFile(path, settings);
  },

  download(input) {
    const baseUrl = ensureV1Suffix(input.endpoint);
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const allModels = [...new Set([...input.modelIds, model])];
    return {
      content: JSON.stringify(
        {
          models: {
            providers: {
              cartethyia: {
                baseUrl,
                apiKey: input.apiKey,
                api: "openai-completions",
                models: allModels.map((m) => ({ id: m, name: m.split("/").pop() ?? m })),
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: `cartethyia/${model}` },
              models: Object.fromEntries(allModels.map((m) => [`cartethyia/${m}`, {}])),
            },
          },
        },
        null,
        2,
      ),
      filename: "openclaw.json",
      mimeType: "application/json",
    };
  },

  messages: {
    applied: "Open Claw settings applied",
    reset: "Cartethyia settings removed from Open Claw",
  },
};

