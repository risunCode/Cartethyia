/**
 * OpenAI Codex CLI injector — writes ~/.codex/config.toml (TOML merge) and
 * ~/.codex/auth.json (API key). Codex uses the Responses API surface.
 *
 * config.toml structure (Cartethyia-injected fields):
 *   model = "model-id"
 *   review_model = "review-model"
 *   model_provider = "cartethyia"
 *   [model_providers.cartethyia]
 *     name = "Cartethyia"
 *     base_url = "http://host:12800/v1"
 *     wire_api = "responses"
 *   [agents]
 *     default_subagent_model = "subagent-model"
 * auth.json:
 *   { "cartethyia": "api-key-secret" }
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  homeDir,
  keyPrefix,
  readJsonFile,
  readTextFile,
  tomlGet,
  tomlHasSection,
  tomlRemoveFlatAll,
  tomlRemoveSectionFlat,
  tomlRemoveSection,
  tomlUpsertRootFlat,
  tomlUpsertSection,
  tomlUpsertSectionFlat,
  removeFile,
  writeJsonFile,
  writeTextFile,
} from "../fs-ops";

const PROVIDER = "cartethyia";
const AUTH_HELPER_NAME = "cartethyia-auth.cjs";
const AUTH_HELPER_SOURCE = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const auth = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth.json'), 'utf8'));",
  "if (typeof auth.cartethyia === 'string') process.stdout.write(auth.cartethyia);",
  "",
].join("\n");

function authHelperPath(): string {
  return `${homeDir()}/.codex/${AUTH_HELPER_NAME}`;
}

function authHelperConfigPath(): string {
  return authHelperPath().replaceAll("\\", "/");
}

function configPath(): string {
  return `${homeDir()}/.codex/config.toml`;
}

function authPath(): string {
  return `${homeDir()}/.codex/auth.json`;
}

export const codexInjector: ToolInjector = {
  toolId: "codex",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await checkBinaryInstalled("codex");
    const text = await readTextFile(path);
    if (!installed && !text) {
      return { toolId: "codex", installed: false, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    if (!text) {
      return { toolId: "codex", installed, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const baseUrl = tomlGet(text, "base_url");
    const model = tomlGet(text, "model");
    const auth = (await readJsonFile(authPath())) as Record<string, string> | null;
    const apiKey = auth?.[PROVIDER] ?? null;
    return {
      toolId: "codex",
      installed,
      configured: tomlHasSection(text, `model_providers.${PROVIDER}`),
      settingsPath: path,
      currentEndpoint: baseUrl,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: model ? [model] : null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const codexDir = `${homeDir()}/.codex`;
    await ensureDir(codexDir);
    const model = input.modelSlots?.session ?? input.activeModel ?? input.models[0] ?? "";
    const subagent = input.modelSlots?.subagent ?? input.subagentModel ?? model;
    const review = input.modelSlots?.review;
    const baseUrl = ensureV1Suffix(input.endpoint);

    // config.toml — read existing, upsert fields.
    let text = (await readTextFile(configPath())) ?? "";
    text = tomlRemoveFlatAll(text, "model");
    text = tomlRemoveFlatAll(text, "review_model");
    text = tomlRemoveFlatAll(text, "model_provider");
    text = tomlUpsertRootFlat(text, "model", model);
    if (review !== undefined) text = tomlUpsertRootFlat(text, "review_model", review);
    text = tomlUpsertRootFlat(text, "model_provider", PROVIDER);
    text = tomlRemoveSection(text, `model_providers.${PROVIDER}.auth`);
    text = tomlUpsertSection(text, `model_providers.${PROVIDER}`, [
      `  name = "Cartethyia"`,
      `  base_url = "${baseUrl}"`,
      `  wire_api = "responses"`,
    ].join("\n"));
    text = tomlUpsertSectionFlat(text, "agents", "default_subagent_model", subagent);
    text = tomlRemoveSection(text, `model_providers.${PROVIDER}.auth`);
    text = tomlUpsertSection(text, `model_providers.${PROVIDER}.auth`, [
      `  command = "node"`,
      `  args = ["${authHelperConfigPath()}"]`,
      `  timeout_ms = 5000`,
      `  refresh_interval_ms = 0`,
    ].join("\n"));
    await writeTextFile(configPath(), text);

    // auth.json — upsert provider key, preserve other keys.
    const auth = ((await readJsonFile(authPath())) as Record<string, string> | null) ?? {};
    auth[PROVIDER] = input.apiKey;
    await writeJsonFile(authPath(), auth);
    await writeTextFile(authHelperPath(), AUTH_HELPER_SOURCE);

    return { success: true, settingsPath: configPath(), message: "Codex CLI settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    let text = await readTextFile(path);
    if (!text) {
      await removeFile(authHelperPath());
      return { success: true, message: "No config file to reset" };
    }
    // Remove our provider section and flat keys pointing to it.
    text = tomlRemoveSection(text, `model_providers.${PROVIDER}.auth`);
    text = tomlRemoveSection(text, `model_providers.${PROVIDER}`);
    text = tomlRemoveSectionFlat(text, "agents", "default_subagent_model");
    text = tomlRemoveSection(text, "agents.subagent");
    // Remove flat keys only if they pointed to our provider.
    if (tomlGet(text, "model_provider") === PROVIDER) {
      text = tomlUpsertRootFlat(text, "model_provider", "openai");
    }
    await writeTextFile(path, text);

    // auth.json — remove only our key.
    const auth = (await readJsonFile(authPath())) as Record<string, string> | null;
    if (auth && auth[PROVIDER]) {
      delete auth[PROVIDER];
      await writeJsonFile(authPath(), auth);
    }
    await removeFile(authHelperPath());
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Codex" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.modelSlots?.session ?? input.activeModel ?? input.models[0] ?? "";
    const subagent = input.modelSlots?.subagent ?? input.subagentModel ?? model;
    const review = input.modelSlots?.review;
    const baseUrl = ensureV1Suffix(input.endpoint);
    const reviewLine = review === undefined ? "" : `review_model = "${review}"\n`;
    const helperPath = authHelperConfigPath();
    const toml = [
      `model = "${model}"`,
      reviewLine.trimEnd(),
      `model_provider = "${PROVIDER}"`,
      "",
      `[model_providers.${PROVIDER}]`,
      `  name = "Cartethyia"`,
      `  base_url = "${baseUrl}"`,
      `  wire_api = "responses"`,
      "",
      `[model_providers.${PROVIDER}.auth]`,
      `  command = "node"`,
      `  args = ["${helperPath}"]`,
      `  timeout_ms = 5000`,
      `  refresh_interval_ms = 0`,
      "",
      "[agents]",
      `  default_subagent_model = "${subagent}"`,
      "",
    ].filter((line) => line.length > 0).join("\n");
    const authJson = JSON.stringify({ [PROVIDER]: input.apiKey }, null, 2);
    const content = [
      "# config.toml",
      toml,
      "# auth.json",
      authJson,
      `# ${AUTH_HELPER_NAME} (save this script as ~/.codex/${AUTH_HELPER_NAME})`,
      AUTH_HELPER_SOURCE,
      "",
    ].join("\n");
    return { content, filename: "codex-config.txt", mimeType: "text/plain" };
  },
};
