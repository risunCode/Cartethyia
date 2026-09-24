import type {} from "../contracts";
import { ensureV1Suffix, homeDir, readJsonFile, writeJsonFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Factory Droid injector spec.
const DROID_PREFIX = "custom:Cartethyia";

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

function isCartethyiaDroidModel(m: { id?: string } | null | undefined): boolean {
  return typeof m?.id === "string" && m.id.startsWith(DROID_PREFIX);
}

export const droidSpec: InjectorSpec = {
  toolId: "droid",
  displayName: "Factory Droid",
  binary: "droid",
  resolvePath: () => `${homeDir()}/.factory/settings.json`,
  resolveDir: () => `${homeDir()}/.factory`,

  async readStatus(path) {
    const settings = (await readJsonFile(path)) as DroidSettings | null;
    const ours = (settings?.customModels ?? []).filter(isCartethyiaDroidModel);
    if (ours.length === 0) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const first = ours[0]!;
    return {
      configured: true,
      currentEndpoint: first.baseUrl ?? null,
      rawApiKey: first.apiKey,
      currentModels: ours.map((m) => m.name),
    };
  },

  async apply(input, path) {
    const existing = ((await readJsonFile(path)) as DroidSettings | null) ?? {};
    const settings: DroidSettings = { ...existing };
    const kept = (settings.customModels ?? []).filter((m) => !isCartethyiaDroidModel(m));
    const baseUrl = ensureV1Suffix(input.endpoint);
    const apiKey = input.apiKey || "your_api_key";
    const added = input.modelIds.map((m): DroidCustomModel => ({
      id: `${DROID_PREFIX}:${m}`,
      name: m,
      baseUrl,
      apiKey,
      provider: "openai",
    }));
    settings.customModels = [...kept, ...added];
    if (input.activeModel) settings.model = input.activeModel;
    await writeJsonFile(path, settings);
  },

  async reset(path) {
    const settings = (await readJsonFile(path)) as DroidSettings | null;
    if (!settings) return false;
    if (settings.customModels) {
      settings.customModels = settings.customModels.filter((m) => !isCartethyiaDroidModel(m));
      if (settings.customModels.length === 0) delete settings.customModels;
    }
    await writeJsonFile(path, settings);
  },

  download(input) {
    const baseUrl = ensureV1Suffix(input.endpoint);
    const apiKey = input.apiKey || "your_api_key";
    const customModels = input.modelIds.map((m): DroidCustomModel => ({
      id: `${DROID_PREFIX}:${m}`,
      name: m,
      baseUrl,
      apiKey,
      provider: "openai",
    }));
    return {
      content: JSON.stringify({ customModels }, null, 2),
      filename: "settings.json",
      mimeType: "application/json",
    };
  },

  messages: {
    applied: "Factory Droid settings applied",
    reset: "Cartethyia settings removed from Factory Droid",
  },
};

