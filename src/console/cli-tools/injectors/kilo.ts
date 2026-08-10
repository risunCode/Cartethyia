/**
 * Kilo Code injector — writes ~/.local/share/kilo/auth.json and VS Code
 * settings.json.
 *
 * auth.json: upsert "openai-compatible" entry with baseUrl, apiKey, model.
 * VS Code settings.json: upsert kilo.code.authProviderOverride setting.
 *
 * Paths:
 *   Linux: ~/.local/share/kilo/auth.json
 *   macOS: ~/Library/Application Support/kilo/auth.json
 *   Windows: %LOCALAPPDATA%/kilo/auth.json
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import { platform } from "node:os";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  homeDir,
  isLocalEndpoint,
  join,
  keyPrefix,
  readJsonFile,
  writeJsonFile,
} from "../fs-ops";

const IS_WIN: boolean = platform() === "win32";
const IS_MAC: boolean = platform() === "darwin";

function resolveKiloDataDirectory(): string {
  if (IS_WIN) return join(process.env.LOCALAPPDATA ?? homeDir(), "kilo");
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", "kilo");
  return join(homeDir(), ".local", "share", "kilo");
}

function authPath(): string {
  return join(resolveKiloDataDirectory(), "auth.json");
}

function vscodeSettingsPath(): string {
  if (IS_WIN) return join(process.env.APPDATA ?? homeDir(), "Code", "User", "settings.json");
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", "Code", "User", "settings.json");
  return join(homeDir(), ".config", "Code", "User", "settings.json");
}

const AUTH_KEY = "openai-compatible";

export const kiloInjector: ToolInjector = {
  toolId: "kilo",

  async getStatus(): Promise<ToolStatus> {
    const path = authPath();
    const installed = await checkBinaryInstalled("kilo", path);
    if (!installed) {
      return { toolId: "kilo", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const auth = (await readJsonFile(path)) as Record<string, { baseUrl?: string; baseURL?: string; apiKey?: string; model?: string }> | null;
    const entry = auth?.[AUTH_KEY] ?? auth?.["cartethyia"];
    if (!entry) {
      return { toolId: "kilo", installed: true, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const baseUrl = entry.baseUrl ?? entry.baseURL ?? null;
    return {
      toolId: "kilo",
      installed: true,
      configured: isLocalEndpoint(baseUrl),
      settingsPath: path,
      currentEndpoint: baseUrl,
      currentApiKeyPrefix: keyPrefix(entry.apiKey),
      currentModels: entry.model ? [entry.model] : null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const dir = resolveKiloDataDirectory();
    await ensureDir(dir);
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const auth = ((await readJsonFile(authPath())) as Record<string, unknown> | null) ?? {};
    auth[AUTH_KEY] = { baseUrl, apiKey: input.apiKey, model };
    auth["cartethyia"] = { baseUrl, apiKey: input.apiKey, model };
    await writeJsonFile(authPath(), auth);

    // VS Code settings — set Kilo to use openai-compatible provider.
    const settings = ((await readJsonFile(vscodeSettingsPath())) as Record<string, unknown> | null) ?? {};
    settings["kilo.code.authProviderOverride"] = "openai-compatible";
    await writeJsonFile(vscodeSettingsPath(), settings);

    return { success: true, settingsPath: authPath(), message: "Kilo Code settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = authPath();
    const auth = (await readJsonFile(path)) as Record<string, unknown> | null;
    if (!auth) return { success: true, message: "No auth file to reset" };
    delete auth[AUTH_KEY];
    delete auth["cartethyia"];
    await writeJsonFile(path, auth);

    // VS Code settings — remove override.
    const settings = (await readJsonFile(vscodeSettingsPath())) as Record<string, unknown> | null;
    if (settings && "kilo.code.authProviderOverride" in settings) {
      delete settings["kilo.code.authProviderOverride"];
      await writeJsonFile(vscodeSettingsPath(), settings);
    }
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Kilo Code" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const content = JSON.stringify({
      [AUTH_KEY]: { baseUrl, apiKey: input.apiKey, model },
      cartethyia: { baseUrl, apiKey: input.apiKey, model },
    }, null, 2);
    return { content, filename: "auth.json", mimeType: "application/json" };
  },
};
