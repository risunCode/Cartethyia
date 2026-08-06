/**
 * DeepSeek TUI injector — writes ~/.deepseek/config.toml (TOML).
 *
 * Config structure:
 *   provider = "openai"
 *   [providers.openai]
 *     base_url = "http://host:12800/v1"
 *     api_key = "key"
 *     model = "model-id"
 *
 * Reset restores `provider = "deepseek"` and removes the openai section.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureV1Suffix,
  homeDir,
  isLocalEndpoint,
  keyPrefix,
  readTextFile,
  tomlGet,
  tomlHasSection,
  tomlRemoveSection,
  tomlUpsertFlat,
  tomlUpsertSection,
  writeTextFile,
} from "../fs-ops";

function configPath(): string {
  return `${homeDir()}/.deepseek/config.toml`;
}

export const deepseekTuiInjector: ToolInjector = {
  toolId: "deepseek-tui",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await checkBinaryInstalled("deepseek", path);
    if (!installed) {
      return { toolId: "deepseek-tui", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const text = await readTextFile(path);
    if (!text) {
      return { toolId: "deepseek-tui", installed: true, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const provider = tomlGet(text, "provider");
    const baseUrl = tomlGet(text, "base_url");
    const model = tomlGet(text, "model");
    const configured = provider === "openai" && tomlHasSection(text, "providers.openai") && isLocalEndpoint(baseUrl);
    return {
      toolId: "deepseek-tui",
      installed: true,
      configured,
      settingsPath: path,
      currentEndpoint: baseUrl,
      currentApiKeyPrefix: keyPrefix(tomlGet(text, "api_key")),
      currentModels: model ? [model] : null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const path = configPath();
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    let text = (await readTextFile(path)) ?? "";
    text = tomlUpsertFlat(text, "provider", "openai");
    text = tomlUpsertSection(text, "providers.openai", [
      `  base_url = "${baseUrl}"`,
      `  api_key = "${input.apiKey}"`,
      `  model = "${model}"`,
    ].join("\n"));
    await writeTextFile(path, text);
    return { success: true, settingsPath: path, message: "DeepSeek TUI settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    let text = await readTextFile(path);
    if (!text) return { success: true, message: "No config file to reset" };
    text = tomlRemoveSection(text, "providers.openai");
    text = tomlUpsertFlat(text, "provider", "deepseek");
    await writeTextFile(path, text);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from DeepSeek TUI" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const content = [
      `provider = "openai"`,
      "",
      "[providers.openai]",
      `  base_url = "${baseUrl}"`,
      `  api_key = "${input.apiKey}"`,
      `  model = "${model}"`,
      "",
    ].join("\n");
    return { content, filename: "config.toml", mimeType: "text/plain" };
  },
};
