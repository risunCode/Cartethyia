/**
 * Grok Build CLI injector — writes ~/.grok/config.toml (TOML merge).
 *
 * config.toml structure (Cartethyia-injected [model] section):
 *   [model]
 *     default = "model-id"
 *     base_url = "http://localhost:12800/v1"
 *     provider = "custom"
 *     api_key = "api-key-secret"
 *
 * Grok uses a custom OpenAI-compatible backend when provider = "custom".
 * The [model] section is upserted in place — all other user config is
 * preserved. Reset removes only the [model] section.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  fileExists,
  homeDir,
  keyPrefix,
  readTextFile,
  tomlGet,
  tomlHasSection,
  tomlRemoveSection,
  tomlUpsertSection,
  writeTextFile,
} from "../fs-ops";

const SECTION = "model";
const PROVIDER = "custom";

function configPath(): string {
  return `${homeDir()}/.grok/config.toml`;
}

function binPath(): string {
  return `${homeDir()}/.grok/bin/grok`;
}

/** Check if grok is installed: binary on PATH, ~/.grok/bin/grok, or config.toml. */
async function isInstalled(): Promise<boolean> {
  if (await checkBinaryInstalled("grok", binPath())) return true;
  return fileExists(configPath());
}

/** Build the body text for the [model] section. */
function modelSectionBody(model: string, baseUrl: string, apiKey: string): string {
  const lines = [
    `default = "${model}"`,
    `base_url = "${baseUrl}"`,
    `provider = "${PROVIDER}"`,
  ];
  if (apiKey) lines.push(`api_key = "${apiKey}"`);
  return lines.join("\n");
}

export const grokBuildInjector: ToolInjector = {
  toolId: "grok-build",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await isInstalled();
    if (!installed) {
      return {
        toolId: "grok-build",
        installed: false,
        configured: false,
        settingsPath: null,
        currentEndpoint: null,
        currentApiKeyPrefix: null,
        currentModels: null,
      };
    }
    const text = await readTextFile(path);
    if (!text) {
      return {
        toolId: "grok-build",
        installed: true,
        configured: false,
        settingsPath: path,
        currentEndpoint: null,
        currentApiKeyPrefix: null,
        currentModels: null,
      };
    }
    const baseUrl = tomlGet(text, "base_url");
    const model = tomlGet(text, "default");
    const apiKey = tomlGet(text, "api_key");
    const configured = tomlHasSection(text, SECTION) && baseUrl !== null;
    return {
      toolId: "grok-build",
      installed: true,
      configured,
      settingsPath: path,
      currentEndpoint: baseUrl,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: model ? [model] : null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const grokDir = `${homeDir()}/.grok`;
    await ensureDir(grokDir);
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const path = configPath();

    let text = (await readTextFile(path)) ?? "";
    text = tomlUpsertSection(text, SECTION, modelSectionBody(model, baseUrl, input.apiKey));
    await writeTextFile(path, text);

    return { success: true, settingsPath: path, message: "Grok Build settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    let text = await readTextFile(path);
    if (!text) return { success: true, message: "No config file to reset" };
    text = tomlRemoveSection(text, SECTION);
    await writeTextFile(path, text);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Grok Build" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const body = modelSectionBody(model, baseUrl, input.apiKey);
    const content = `[${SECTION}]\n${body}\n`;
    return { content, filename: "grok-config.toml", mimeType: "text/plain" };
  },
};
