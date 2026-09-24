import { platform } from "node:os";
import type { ApplyInput } from "../contracts";
import { ensureV1Suffix, fileExists, homeDir, join, readJsonFile, writeJsonFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

// GitHub Copilot injector spec.
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

function buildCopilotEntry(input: ApplyInput): CopilotEntry {
  const url = `${ensureV1Suffix(input.endpoint)}/chat/completions#models.ai.azure.com`;
  return {
    name: "Cartethyia",
    vendor: "azure",
    apiKey: input.apiKey,
    models: input.modelIds.map((id) => ({
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

export const copilotSpec: InjectorSpec = {
  toolId: "copilot",
  displayName: "Copilot",
  checkInstalled: (path) => fileExists(path),
  resolvePath: () => {
    const home = homeDir();
    if (IS_WIN) return join(process.env.APPDATA ?? home, "Code", "User", "chatLanguageModels.json");
    if (IS_MAC)
      return join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "chatLanguageModels.json",
      );
    return join(home, ".config", "Code", "User", "chatLanguageModels.json");
  },

  async readStatus(path) {
    const config = await readJsonFile(path);
    const entry = Array.isArray(config)
      ? ((config as CopilotEntry[]).find((e) => e?.name === "Cartethyia") ?? null)
      : null;
    return {
      configured: entry !== null,
      currentEndpoint: entry?.models?.[0]?.url ?? null,
      rawApiKey: entry?.apiKey ?? null,
      currentModels: entry?.models?.map((m) => m.id) ?? null,
    };
  },

  async apply(input, path) {
    const existing = await readJsonFile(path);
    const config = Array.isArray(existing) ? [...(existing as CopilotEntry[])] : [];
    const entry = buildCopilotEntry(input);
    const idx = config.findIndex((e) => e?.name === "Cartethyia");
    if (idx >= 0) config[idx] = entry;
    else config.push(entry);
    await writeJsonFile(path, config);
  },

  async reset(path) {
    const existing = await readJsonFile(path);
    if (!existing || !Array.isArray(existing)) return false;
    const config = (existing as CopilotEntry[]).filter((e) => e?.name !== "Cartethyia");
    await writeJsonFile(path, config);
  },

  download(input) {
    return {
      content: JSON.stringify([buildCopilotEntry(input)], null, 2),
      filename: "chatLanguageModels.json",
      mimeType: "application/json",
    };
  },

  messages: {
    applied: "Copilot settings applied — reload VS Code to take effect",
    reset: "Cartethyia removed from Copilot config",
    resetMissing: "No config file to reset",
  },
};

