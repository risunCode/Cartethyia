/**
 * Claude Code injector — writes the native Anthropic connection to
 * ~/.claude/settings.json.
 *
 * Claude Code owns model selection. Cartethyia only manages the base URL and
 * authentication token; model routing remains a server-side concern.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  homeDir,
  isLocalEndpoint,
  keyPrefix,
  readJsonFile,
  stripV1Suffix,
  writeJsonFile,
} from "../fs-ops";
function settingsPath(): string {
  return `${homeDir()}/.claude/settings.json`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function envKeys(): readonly string[] {
  return [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    // Remove the legacy key when resetting older Cartethyia-managed settings.
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "API_TIMEOUT_MS",
  ];
}


export const claudeInjector: ToolInjector = {
  toolId: "claude",

  async getStatus(): Promise<ToolStatus> {
    const path = settingsPath();
    const installed = await checkBinaryInstalled("claude");
    const settings = (await readJsonFile(path)) as { env?: Record<string, string> } | null;
    if (!installed && settings === null) {
      return { toolId: "claude", installed: false, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const env = settings?.env;
    const endpoint = env?.ANTHROPIC_BASE_URL ?? null;
    const apiKey = env?.ANTHROPIC_AUTH_TOKEN ?? null;
    const models = env
      ? [env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.ANTHROPIC_DEFAULT_FABLE_MODEL, env.ANTHROPIC_DEFAULT_MODEL]
        .filter((model): model is string => typeof model === "string")
      : null;
    return {
      toolId: "claude",
      installed,
      configured: isLocalEndpoint(endpoint),
      settingsPath: path,
      currentEndpoint: endpoint,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: models,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const path = settingsPath();
    const dir = `${homeDir()}/.claude`;
    await ensureDir(dir);
    const existing = (await readJsonFile(path)) as Record<string, unknown> | null;
    const settings = (existing ?? {}) as Record<string, unknown>;
    const env = (settings.env as Record<string, string> | undefined) ?? {};
    // Claude Code owns model selection. Cartethyia only supplies the
    // Anthropic-compatible endpoint and credential, matching the native setup.
    for (const key of envKeys()) {
      if (key !== "ANTHROPIC_BASE_URL" && key !== "ANTHROPIC_AUTH_TOKEN") delete env[key];
    }
    env.ANTHROPIC_BASE_URL = stripV1Suffix(input.endpoint);
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
    delete settings.model;
    delete settings.smallModel;
    if (input.bypassPermissions === true) {
      const permissions = recordValue(settings.permissions) ?? {};
      permissions.defaultMode = "bypassPermissions";
      settings.permissions = permissions;
      settings.skipDangerousModePermissionPrompt = true;
    }
    settings.env = env;
    settings.hasCompletedOnboarding = true;
    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Claude Code settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = settingsPath();
    const settings = (await readJsonFile(path)) as Record<string, unknown> | null;
    if (!settings) return { success: true, message: "No settings file to reset" };
    const env = settings.env;
    if (env !== null && typeof env === "object" && !Array.isArray(env)) {
      for (const key of envKeys()) delete (env as Record<string, unknown>)[key];
    }
    delete settings.model;
    delete settings.smallModel;
    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Claude Code" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: stripV1Suffix(input.endpoint),
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
    };
    const settings: Record<string, unknown> = { hasCompletedOnboarding: true, env };
    if (input.bypassPermissions === true) {
      settings.permissions = { defaultMode: "bypassPermissions" };
      settings.skipDangerousModePermissionPrompt = true;
    }
    const content = JSON.stringify(settings, null, 2);
    return { content, filename: "settings.json", mimeType: "application/json" };
  },
};

