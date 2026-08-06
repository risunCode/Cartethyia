/**
 * Open Claw injector — writes ~/.openclaw/openclaw.json with provider config,
 * model defaults, and per-agent model mappings.
 *
 * OpenClaw config structure:
 *   settings.models.providers.cartethyia = { baseUrl, apiKey, api, models }
 *   settings.agents.defaults.model.primary = "cartethyia/model"
 *   settings.agents.defaults.models["cartethyia/model"] = {}
 *   settings.agents.list[].model = "cartethyia/model" (per-agent override)
 *
 * Per-agent models.json files are written to agent.agentDir if present.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  homeDir,
  join,
  keyPrefix,
  readJsonFile,
  writeJsonFile,
} from "../fs-ops";

const PROVIDER = "cartethyia";

function settingsPath(): string {
  return join(homeDir(), ".openclaw", "openclaw.json");
}

/** Resolve agent model to string id (OpenClaw may store as { primary, fallbacks }). */
function resolveAgentModel(m: unknown): string {
  if (typeof m === "string") return m;
  if (m !== null && typeof m === "object" && "primary" in m) return (m as { primary: string }).primary;
  return "";
}

export const openclawInjector: ToolInjector = {
  toolId: "openclaw",

  async getStatus(): Promise<ToolStatus> {
    const path = settingsPath();
    const installed = await checkBinaryInstalled("openclaw", path);
    if (!installed) {
      return { toolId: "openclaw", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const settings = (await readJsonFile(path)) as {
      models?: { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Array<{ id: string }> }> };
      agents?: { defaults?: { model?: { primary?: string } | string } };
    } | null;
    if (!settings) {
      return { toolId: "openclaw", installed: true, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const provider = settings.models?.providers?.[PROVIDER];
    const primaryModel = resolveAgentModel(settings.agents?.defaults?.model);
    return {
      toolId: "openclaw",
      installed: true,
      configured: !!provider,
      settingsPath: path,
      currentEndpoint: provider?.baseUrl ?? null,
      currentApiKeyPrefix: keyPrefix(provider?.apiKey),
      currentModels: primaryModel ? [primaryModel] : (provider?.models?.map((m) => m.id) ?? null),
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const path = settingsPath();
    await ensureDir(join(homeDir(), ".openclaw"));
    const settings = ((await readJsonFile(path)) as Record<string, unknown> | null) ?? {};

    // Ensure nested structure.
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
    const allModels = [...new Set([...input.models, ...(input.activeModel ? [input.activeModel] : [])])];

    // Remove old cartethyia/* model entries.
    const defaultModels = defaults.models as Record<string, unknown>;
    for (const key of Object.keys(defaultModels)) {
      if (key.startsWith(`${PROVIDER}/`)) delete defaultModels[key];
    }

    // Set default model.
    (defaults.model as { primary: string }).primary = `${PROVIDER}/${input.activeModel ?? input.models[0] ?? ""}`;

    // Add fresh models to allowlist.
    for (const m of allModels) {
      defaultModels[`${PROVIDER}/${m}`] = {};
    }

    // Update provider.
    providers[PROVIDER] = {
      baseUrl,
      apiKey: input.apiKey,
      api: "openai-completions",
      models: allModels.map((m) => ({ id: m, name: m.split("/").pop() ?? m })),
    };

    // Remove old cartethyia model from agent list entries.
    if (Array.isArray(agents.list)) {
      agents.list = (agents.list as Array<Record<string, unknown>>).map((agent) => {
        if (resolveAgentModel(agent.model).startsWith(`${PROVIDER}/`)) {
          const { model: _m, ...rest } = agent;
          void _m;
          return rest;
        }
        return agent;
      });
    }

    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Open Claw settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = settingsPath();
    const settings = (await readJsonFile(path)) as {
      models?: { providers?: Record<string, unknown> };
      agents?: { defaults?: { model?: { primary?: string } | string; models?: Record<string, unknown> } };
    } | null;
    if (!settings) return { success: true, message: "No settings file to reset" };

    // Remove provider.
    settings.models?.providers && delete settings.models.providers[PROVIDER];

    // Remove cartethyia/* model entries.
    const defaultModels = settings.agents?.defaults?.models;
    if (defaultModels) {
      for (const key of Object.keys(defaultModels)) {
        if (key.startsWith(`${PROVIDER}/`)) delete defaultModels[key];
      }
    }

    // Clear default model if it points to cartethyia.
    const primary = resolveAgentModel(settings.agents?.defaults?.model);
    if (primary.startsWith(`${PROVIDER}/`)) {
      if (settings.agents?.defaults?.model && typeof settings.agents.defaults.model === "object") {
        (settings.agents.defaults.model as { primary: string }).primary = "";
      }
    }

    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Open Claw" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const baseUrl = ensureV1Suffix(input.endpoint);
    const model = input.activeModel ?? input.models[0] ?? "";
    const allModels = [...new Set([...input.models, model])];
    const content = JSON.stringify({
      models: {
        providers: {
          [PROVIDER]: {
            baseUrl,
            apiKey: input.apiKey,
            api: "openai-completions",
            models: allModels.map((m) => ({ id: m, name: m.split("/").pop() ?? m })),
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: `${PROVIDER}/${model}` },
          models: Object.fromEntries(allModels.map((m) => [`${PROVIDER}/${m}`, {}])),
        },
      },
    }, null, 2);
    return { content, filename: "openclaw.json", mimeType: "application/json" };
  },
};
