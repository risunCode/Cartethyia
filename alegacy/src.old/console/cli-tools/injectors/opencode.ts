/**
 * OpenCode injector — writes `~/.config/opencode/opencode.json` (JSON merge).
 *
 * OpenCode uses an OpenAI-compatible provider plugin. Cartethyia registers as
 * the "cartethyia" provider with `@ai-sdk/openai-compatible`, lists each model
 * with text/image input modalities, and sets the active `model` to
 * `cartethyia/<activeModel>`. A fast `explorer` subagent is also wired to
 * `cartethyia/<subagentModel>`.
 *
 * - getStatus: `which`/`where opencode` with config-file fallback; configured
 *   iff `provider.cartethyia` exists.
 * - apply: merge provider entry, models map, active model, and explorer
 *   subagent into existing JSON, preserving all other fields.
 * - reset: remove only Cartethyia-injected fields — `provider.cartethyia`,
 *   `model` when it starts with `cartethyia/`, and `agent.explorer` when its
 *   model points at Cartethyia.
 * - download: render the opencode.json body without touching the filesystem.
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
const NPM = "@ai-sdk/openai-compatible";

interface OpencodeModel {
  name: string;
  modalities: { input: string[]; output: string[] };
}

interface OpencodeProvider {
  npm: string;
  options: { baseURL?: string; apiKey?: string };
  models: Record<string, OpencodeModel>;
}

interface OpencodeConfig {
  provider?: Record<string, OpencodeProvider>;
  model?: string;
  agent?: {
    explorer?: {
      description?: string;
      mode?: string;
      model?: string;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function configPath(): string {
  return join(homeDir(), ".config", "opencode", "opencode.json");
}

/** Build the models map for the given model IDs. */
function buildModels(models: readonly string[]): Record<string, OpencodeModel> {
  const map: Record<string, OpencodeModel> = {};
  for (const m of models) {
    if (!m) continue;
    map[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
  }
  return map;
}

export const opencodeInjector: ToolInjector = {
  toolId: "opencode",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await checkBinaryInstalled("opencode", path);
    if (!installed) {
      return {
        toolId: "opencode",
        installed: false,
        configured: false,
        settingsPath: null,
        currentEndpoint: null,
        currentApiKeyPrefix: null,
        currentModels: null,
      };
    }
    const config = (await readJsonFile(path)) as OpencodeConfig | null;
    if (!config) {
      return {
        toolId: "opencode",
        installed: true,
        configured: false,
        settingsPath: path,
        currentEndpoint: null,
        currentApiKeyPrefix: null,
        currentModels: null,
      };
    }
    const provider = config.provider?.[PROVIDER];
    const endpoint = provider?.options?.baseURL ?? null;
    const apiKey = provider?.options?.apiKey ?? null;
    const models = provider?.models ? Object.keys(provider.models) : null;
    const active =
      typeof config.model === "string" && config.model.startsWith(`${PROVIDER}/`)
        ? config.model.slice(PROVIDER.length + 1)
        : null;
    return {
      toolId: "opencode",
      installed: true,
      configured: !!provider,
      settingsPath: path,
      currentEndpoint: endpoint,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: active && models ? [active, ...models.filter((m) => m !== active)] : models,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const path = configPath();
    await ensureDir(join(homeDir(), ".config", "opencode"));

    const existing = (await readJsonFile(path)) as OpencodeConfig | null;
    const config: OpencodeConfig = (existing ?? {}) as OpencodeConfig;

    // Ensure provider object exists; preserve other providers.
    if (!config.provider) config.provider = {};

    // Merge cartethyia provider entry, preserving any existing models.
    const prior = config.provider[PROVIDER];
    const provider: OpencodeProvider = {
      npm: NPM,
      options: {
        ...(prior?.options ?? {}),
        baseURL: ensureV1Suffix(input.endpoint),
        apiKey: input.apiKey,
      },
      models: { ...(prior?.models ?? {}), ...buildModels(input.models) },
    };
    config.provider[PROVIDER] = provider;

    // Set active model: explicit empty string clears it; otherwise prefer
    // activeModel, then the first configured model.
    const activeModel = input.activeModel ?? input.models[0] ?? "";
    if (activeModel === "") {
      config.model = "";
    } else {
      config.model = `${PROVIDER}/${activeModel}`;
    }

    // Wire the explorer subagent to Cartethyia.
    if (!config.agent) config.agent = {};
    const subagentModel = input.subagentModel ?? input.models[0] ?? activeModel;
    config.agent.explorer = {
      description: "Fast explorer subagent",
      mode: "subagent",
      model: `${PROVIDER}/${subagentModel}`,
    };

    await writeJsonFile(path, config);
    return { success: true, settingsPath: path, message: "OpenCode settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    const config = (await readJsonFile(path)) as OpencodeConfig | null;
    if (!config) return { success: true, message: "No config file to reset" };

    // Remove only the Cartethyia provider entry.
    if (config.provider) {
      delete config.provider[PROVIDER];
      if (Object.keys(config.provider).length === 0) delete config.provider;
    }

    // Clear the active model only if it points at Cartethyia.
    if (typeof config.model === "string" && config.model.startsWith(`${PROVIDER}/`)) {
      delete config.model;
    }

    // Remove the explorer subagent only if it was wired to Cartethyia.
    if (config.agent?.explorer?.model?.startsWith(`${PROVIDER}/`)) {
      delete config.agent.explorer;
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await writeJsonFile(path, config);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from OpenCode" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const activeModel = input.activeModel ?? input.models[0] ?? "";
    const subagentModel = input.subagentModel ?? input.models[0] ?? activeModel;
    const config: OpencodeConfig = {
      provider: {
        [PROVIDER]: {
          npm: NPM,
          options: {
            baseURL: ensureV1Suffix(input.endpoint),
            apiKey: input.apiKey,
          },
          models: buildModels(input.models),
        },
      },
      model: activeModel === "" ? "" : `${PROVIDER}/${activeModel}`,
      agent: {
        explorer: {
          description: "Fast explorer subagent",
          mode: "subagent",
          model: `${PROVIDER}/${subagentModel}`,
        },
      },
    };
    const content = JSON.stringify(config, null, 2);
    return { content, filename: "opencode.json", mimeType: "application/json" };
  },
};
