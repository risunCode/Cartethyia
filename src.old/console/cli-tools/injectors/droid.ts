/**
 * Factory Droid injector — writes customModels to ~/.factory/settings.json.
 *
 * - settings.customModels: remove existing Cartethyia entries, then add one
 *   per model: { id: "custom:Cartethyia:<model>", name, baseUrl, apiKey,
 *   provider: "openai" }. Other user-defined customModels are preserved.
 * - settings.model: set to activeModel when provided.
 * - Reset removes only Cartethyia entries (id starts "custom:Cartethyia").
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  homeDir,
  keyPrefix,
  readJsonFile,
  writeJsonFile,
} from "../fs-ops";

/** ID prefix marking a Cartethyia-managed custom model entry. */
const CARTETHYIA_PREFIX = "custom:Cartethyia";

function settingsPath(): string {
  return `${homeDir()}/.factory/settings.json`;
}

interface DroidCustomModel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
}

interface DroidSettings {
  customModels?: DroidCustomModel[];
  model?: string;
  [k: string]: unknown;
}

function isCartethyiaModel(m: { id?: string } | null | undefined): boolean {
  return typeof m?.id === "string" && m.id.startsWith(CARTETHYIA_PREFIX);
}

export const droidInjector: ToolInjector = {
  toolId: "droid",

  async getStatus(): Promise<ToolStatus> {
    const path = settingsPath();
    const installed = await checkBinaryInstalled("droid", path);
    if (!installed) {
      return { toolId: "droid", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const settings = (await readJsonFile(path)) as DroidSettings | null;
    const ours = (settings?.customModels ?? []).filter(isCartethyiaModel);
    if (ours.length === 0) {
      return { toolId: "droid", installed: true, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const first = ours[0]!;
    return {
      toolId: "droid",
      installed: true,
      configured: true,
      settingsPath: path,
      currentEndpoint: first.baseUrl ?? null,
      currentApiKeyPrefix: keyPrefix(first.apiKey),
      currentModels: ours.map((m) => m.name),
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const path = settingsPath();
    await ensureDir(`${homeDir()}/.factory`);
    const existing = ((await readJsonFile(path)) as DroidSettings | null) ?? {};
    const settings: DroidSettings = { ...existing };
    // Merge: keep user's non-Cartethyia models, drop our stale entries.
    const kept = (settings.customModels ?? []).filter((m) => !isCartethyiaModel(m));
    const baseUrl = ensureV1Suffix(input.endpoint);
    const apiKey = input.apiKey || "your_api_key";
    const added = input.models.map(
      (m): DroidCustomModel => ({
        id: `${CARTETHYIA_PREFIX}:${m}`,
        name: m,
        baseUrl,
        apiKey,
        provider: "openai",
      }),
    );
    settings.customModels = [...kept, ...added];
    if (input.activeModel) settings.model = input.activeModel;
    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Factory Droid settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = settingsPath();
    const settings = (await readJsonFile(path)) as DroidSettings | null;
    if (!settings) return { success: true, message: "No settings file to reset" };
    if (settings.customModels) {
      settings.customModels = settings.customModels.filter((m) => !isCartethyiaModel(m));
      if (settings.customModels.length === 0) delete settings.customModels;
    }
    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Factory Droid" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const baseUrl = ensureV1Suffix(input.endpoint);
    const apiKey = input.apiKey || "your_api_key";
    const customModels = input.models.map((m): DroidCustomModel => ({
      id: `${CARTETHYIA_PREFIX}:${m}`,
      name: m,
      baseUrl,
      apiKey,
      provider: "openai",
    }));
    const content = JSON.stringify({ customModels }, null, 2);
    return { content, filename: "settings.json", mimeType: "application/json" };
  },
};
