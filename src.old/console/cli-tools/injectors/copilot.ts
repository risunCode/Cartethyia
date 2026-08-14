/**
 * GitHub Copilot injector — adds a Cartethyia language-model provider entry
 * to VS Code's `chatLanguageModels.json`.
 *
 * The config file is a JSON array; Cartethyia adds or replaces the entry with
 * `name === "Cartethyia"`, preserving all other entries. The provider URL uses
 * the Azure vendor pattern required by VS Code:
 * `${ensureV1Suffix(endpoint)}/chat/completions#models.ai.azure.com`.
 *
 * The dependency is VS Code (not a CLI binary), so "installed" is reported when
 * the config file already exists.
 */

import { dirname } from "node:path";
import { platform } from "node:os";

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  ensureDir,
  ensureV1Suffix,
  fileExists,
  homeDir,
  join,
  keyPrefix,
  readJsonFile,
  writeJsonFile,
} from "../fs-ops";

const PROVIDER_NAME = "Cartethyia";

interface CopilotModel {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
}

interface CopilotEntry {
  name: string;
  vendor: string;
  apiKey: string;
  models: CopilotModel[];
}

/** Resolve the OS-specific chatLanguageModels.json path. */
function configPath(): string {
  const home = homeDir();
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? home, "Code", "User", "chatLanguageModels.json");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  return join(home, ".config", "Code", "User", "chatLanguageModels.json");
}

/** Build the Cartethyia array entry from apply/download input. */
function buildEntry(input: ApplyInput): CopilotEntry {
  const url = `${ensureV1Suffix(input.endpoint)}/chat/completions#models.ai.azure.com`;
  return {
    name: PROVIDER_NAME,
    vendor: "azure",
    apiKey: input.apiKey,
    models: input.models.map((id) => ({
      id,
      name: id,
      url,
      toolCalling: true,
      vision: false,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
    })),
  };
}

export const copilotInjector: ToolInjector = {
  toolId: "copilot",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await fileExists(path);
    if (!installed) {
      return { toolId: "copilot", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const config = await readJsonFile(path);
    const entry = Array.isArray(config) ? (config as CopilotEntry[]).find((e) => e?.name === PROVIDER_NAME) ?? null : null;
    const endpoint = entry?.models?.[0]?.url ?? null;
    const apiKey = entry?.apiKey ?? null;
    const models = entry?.models?.map((m) => m.id) ?? null;
    return {
      toolId: "copilot",
      installed: true,
      configured: entry !== null,
      settingsPath: path,
      currentEndpoint: endpoint,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: models,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const path = configPath();
    await ensureDir(dirname(path));
    const existing = await readJsonFile(path);
    const config = Array.isArray(existing) ? [...(existing as CopilotEntry[])] : [];
    const entry = buildEntry(input);
    const idx = config.findIndex((e) => e?.name === PROVIDER_NAME);
    if (idx >= 0) {
      config[idx] = entry;
    } else {
      config.push(entry);
    }
    await writeJsonFile(path, config);
    return { success: true, settingsPath: path, message: "Copilot settings applied — reload VS Code to take effect" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    const existing = await readJsonFile(path);
    if (!existing) return { success: true, message: "No config file to reset" };
    if (!Array.isArray(existing)) return { success: true, message: "No Cartethyia config to reset" };
    const config = (existing as CopilotEntry[]).filter((e) => e?.name !== PROVIDER_NAME);
    await writeJsonFile(path, config);
    return { success: true, settingsPath: path, message: "Cartethyia removed from Copilot config" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const entry = buildEntry(input);
    const content = JSON.stringify([entry], null, 2);
    return { content, filename: "chatLanguageModels.json", mimeType: "application/json" };
  },
};
