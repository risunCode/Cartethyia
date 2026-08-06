/**
 * jcode injector — writes ~/.jcode/config.toml (TOML) and
 * ~/.config/jcode/provider-cartethyia.env (env file).
 *
 * config.toml structure:
 *   [providers.cartethyia]
 *     type = "openai"
 *     base_url = "http://host:12800/v1"
 *     env_file = "provider-cartethyia.env"
 *     model = "model-id"
 *
 * provider-cartethyia.env:
 *   OPENAI_API_KEY=key
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  envGet,
  envRemove,
  envUpsert,
  homeDir,
  isLocalEndpoint,
  join,
  keyPrefix,
  readTextFile,
  tomlGet,
  tomlHasSection,
  tomlRemoveSection,
  tomlUpsertSection,
  writeTextFile,
} from "../fs-ops";

function configDir(): string {
  return join(homeDir(), ".jcode");
}

function configPath(): string {
  return join(configDir(), "config.toml");
}

function envFileDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homeDir(), ".config"), "jcode");
}

function envFilePath(): string {
  return join(envFileDir(), "provider-cartethyia.env");
}

const PROVIDER = "cartethyia";
const ENV_KEY = "OPENAI_API_KEY";

export const jcodeInjector: ToolInjector = {
  toolId: "jcode",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await checkBinaryInstalled("jcode", path);
    if (!installed) {
      return { toolId: "jcode", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const text = await readTextFile(path);
    if (!text) {
      return { toolId: "jcode", installed: true, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const configured = tomlHasSection(text, `providers.${PROVIDER}`);
    const baseUrl = tomlGet(text, "base_url");
    const envText = await readTextFile(envFilePath());
    const apiKey = envText ? envGet(envText, ENV_KEY) : null;
    return {
      toolId: "jcode",
      installed: true,
      configured,
      settingsPath: path,
      currentEndpoint: isLocalEndpoint(baseUrl) ? baseUrl : null,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);

    // config.toml
    await ensureDir(configDir());
    let text = (await readTextFile(configPath())) ?? "";
    text = tomlUpsertSection(text, `providers.${PROVIDER}`, [
      `  type = "openai"`,
      `  base_url = "${baseUrl}"`,
      `  env_file = "provider-cartethyia.env"`,
      `  model = "${model}"`,
    ].join("\n"));
    await writeTextFile(configPath(), text);

    // env file
    await ensureDir(envFileDir());
    let envText = (await readTextFile(envFilePath())) ?? "";
    envText = envUpsert(envText, ENV_KEY, input.apiKey);
    await writeTextFile(envFilePath(), envText);

    return { success: true, settingsPath: configPath(), message: "jcode settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    let text = await readTextFile(path);
    if (text) {
      text = tomlRemoveSection(text, `providers.${PROVIDER}`);
      await writeTextFile(path, text);
    }
    const envText = await readTextFile(envFilePath());
    if (envText) {
      await writeTextFile(envFilePath(), envRemove(envText, ENV_KEY));
    }
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from jcode" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const toml = [
      `[providers.${PROVIDER}]`,
      `  type = "openai"`,
      `  base_url = "${baseUrl}"`,
      `  env_file = "provider-cartethyia.env"`,
      `  model = "${model}"`,
      "",
    ].join("\n");
    const envFile = `${ENV_KEY}=${input.apiKey}\n`;
    const content = `# config.toml\n${toml}\n# provider-cartethyia.env\n${envFile}`;
    return { content, filename: "jcode-config.txt", mimeType: "text/plain" };
  },
};
