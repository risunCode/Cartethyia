/**
 * Cline injector — writes ~/.cline/data/globalState.json (provider + endpoint +
 * model slots) and ~/.cline/data/secrets.json (API key). Cline uses the
 * OpenAI-compatible chat surface and expects base URLs WITHOUT a /v1 suffix.
 *
 * globalState.json (Cartethyia-injected fields, all merged into existing JSON):
 *   actModeApiProvider = "openai"
 *   planModeApiProvider = "openai"
 *   openAiBaseUrl = "http://host:12800"   (no /v1)
 *   openAiModelId = "model-id"
 *   planModeOpenAiModelId = "model-id"
 *
 * secrets.json:
 *   openAiApiKey = "api-key-secret"
 *
 * Reset restores providers to "cline" and removes the injected fields + key.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  homeDir,
  isLocalEndpoint,
  keyPrefix,
  readJsonFile,
  stripV1Suffix,
  writeJsonFile,
} from "../fs-ops";

interface ClineGlobalState {
  actModeApiProvider?: string;
  planModeApiProvider?: string;
  openAiBaseUrl?: string;
  openAiModelId?: string;
  planModeOpenAiModelId?: string;
  [key: string]: unknown;
}

interface ClineSecrets {
  openAiApiKey?: string;
  [key: string]: unknown;
}

function resolveClineDataDirectory(): string {
  return `${homeDir()}/.cline/data`;
}

function globalStatePath(): string {
  return `${resolveClineDataDirectory()}/globalState.json`;
}

function secretsPath(): string {
  return `${resolveClineDataDirectory()}/secrets.json`;
}

/** Cline is considered configured for Cartethyia when the act-mode provider is
 *  "openai" and the OpenAI base URL points at a local/Cartethyia endpoint. */
function isConfigured(state: ClineGlobalState | null): boolean {
  if (!state) return false;
  return state.actModeApiProvider === "openai" && isLocalEndpoint(state.openAiBaseUrl);
}

export const clineInjector: ToolInjector = {
  toolId: "cline",

  async getStatus(): Promise<ToolStatus> {
    const path = globalStatePath();
    const installed = await checkBinaryInstalled("cline", path);
    if (!installed) {
      return { toolId: "cline", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const state = (await readJsonFile(path)) as ClineGlobalState | null;
    const secrets = (await readJsonFile(secretsPath())) as ClineSecrets | null;
    const endpoint = state?.openAiBaseUrl ?? null;
    const apiKey = secrets?.openAiApiKey ?? null;
    const models = [state?.openAiModelId, state?.planModeOpenAiModelId].filter((m): m is string => typeof m === "string");
    return {
      toolId: "cline",
      installed: true,
      configured: isConfigured(state),
      settingsPath: path,
      currentEndpoint: endpoint,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: models.length > 0 ? models : null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    await ensureDir(resolveClineDataDirectory());
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = stripV1Suffix(input.endpoint);

    // globalState.json — merge into existing, preserve all other fields.
    const state = ((await readJsonFile(globalStatePath())) as ClineGlobalState | null) ?? {};
    state.actModeApiProvider = "openai";
    state.planModeApiProvider = "openai";
    state.openAiBaseUrl = baseUrl;
    state.openAiModelId = model;
    state.planModeOpenAiModelId = model;
    await writeJsonFile(globalStatePath(), state);

    // secrets.json — upsert key, preserve everything else.
    const secrets = ((await readJsonFile(secretsPath())) as ClineSecrets | null) ?? {};
    secrets.openAiApiKey = input.apiKey;
    await writeJsonFile(secretsPath(), secrets);

    return { success: true, settingsPath: globalStatePath(), message: "Cline settings applied successfully" };
  },

  async reset(): Promise<ApplyResult> {
    const path = globalStatePath();
    const state = (await readJsonFile(path)) as ClineGlobalState | null;
    if (!state) {
      return { success: true, message: "No settings file to reset" };
    }

    // Only touch our injected fields; restore providers to Cline's default.
    if (state.actModeApiProvider === "openai") {
      delete state.openAiBaseUrl;
      delete state.openAiModelId;
      delete state.planModeOpenAiModelId;
      state.actModeApiProvider = "cline";
      state.planModeApiProvider = "cline";
    }
    await writeJsonFile(path, state);

    // secrets.json — remove only our key.
    const secrets = (await readJsonFile(secretsPath())) as ClineSecrets | null;
    if (secrets && secrets.openAiApiKey) {
      delete secrets.openAiApiKey;
      await writeJsonFile(secretsPath(), secrets);
    }

    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Cline" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = stripV1Suffix(input.endpoint);
    const globalState = JSON.stringify({
      actModeApiProvider: "openai",
      planModeApiProvider: "openai",
      openAiBaseUrl: baseUrl,
      openAiModelId: model,
      planModeOpenAiModelId: model,
    }, null, 2);
    const secrets = JSON.stringify({ openAiApiKey: input.apiKey }, null, 2);
    const content = `# ~/.cline/data/globalState.json\n${globalState}\n\n# ~/.cline/data/secrets.json\n${secrets}\n`;
    return { content, filename: "cline-config.txt", mimeType: "text/plain" };
  },
};
