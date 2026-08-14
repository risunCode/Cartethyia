/**
 * jcode injector — writes only the provider endpoint/model configuration.
 *
 * Cartethyia owns provider credentials in its provider configuration and
 * secret store. This legacy injector never writes or reads provider secret
 * environment variables or env files.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  homeDir,
  isLocalEndpoint,
  join,
  readTextFile,
  tomlGet,
  tomlHasSection,
  tomlRemoveSection,
  tomlUpsertSection,
  writeTextFile,
} from "../fs-ops";

const PROVIDER = "cartethyia";

function configDir(): string {
  return join(homeDir(), ".jcode");
}

function configPath(): string {
  return join(configDir(), "config.toml");
}

export const jcodeInjector: ToolInjector = {
  toolId: "jcode",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await checkBinaryInstalled("jcode", path);
    if (!installed) {
      return { toolId: "jcode", installed: false, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const text = await readTextFile(path);
    if (!text) {
      return { toolId: "jcode", installed: true, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const baseUrl = tomlGet(text, "base_url");
    return {
      toolId: "jcode",
      installed: true,
      configured: tomlHasSection(text, `providers.${PROVIDER}`),
      settingsPath: path,
      currentEndpoint: isLocalEndpoint(baseUrl) ? baseUrl : null,
      currentApiKeyPrefix: null,
      currentModels: null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    await ensureDir(configDir());
    let text = (await readTextFile(configPath())) ?? "";
    text = tomlUpsertSection(text, `providers.${PROVIDER}`, [
      `  type = "openai"`,
      `  base_url = "${baseUrl}"`,
      `  model = "${model}"`,
    ].join("\n"));
    await writeTextFile(configPath(), text);
    return { success: true, settingsPath: configPath(), message: "jcode provider settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    const text = await readTextFile(path);
    if (text) await writeTextFile(path, tomlRemoveSection(text, `providers.${PROVIDER}`));
    return { success: true, settingsPath: path, message: "Cartethyia provider settings removed from jcode" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const content = [
      `# config.toml`,
      `[providers.${PROVIDER}]`,
      `  type = "openai"`,
      `  base_url = "${baseUrl}"`,
      `  model = "${model}"`,
      "",
    ].join("\n");
    return { content, filename: "jcode-config.toml", mimeType: "text/toml" };
  },
};
