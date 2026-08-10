/**
 * Claude Code injector — writes env vars to ~/.claude/settings.json and
 * MCP server config to ~/.claude.json.
 *
 * - settings.json: merge env block (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
 *   model defaults) into existing JSON, preserving all other fields.
 * - .claude.json: no MCP injection for Cartethyia (we are the proxy, not an
 *   MCP server). Only settings.json env is managed.
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

function slotModel(input: ApplyInput, slotKey: string, index: number): string | undefined {
  return input.modelSlots?.[slotKey] ?? input.models[index];
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
    // Claude Code appends `/v1/messages` to ANTHROPIC_BASE_URL itself.
    // Store the host base so a configured `/v1` endpoint does not become `/v1/v1/messages`.
    env.ANTHROPIC_BASE_URL = stripV1Suffix(input.endpoint);
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
    // Remove the legacy custom slot before writing the canonical Mythos setting.
    delete env.ANTHROPIC_CUSTOM_MODEL_OPTION;
    const opus = slotModel(input, "opus", 0);
    const sonnet = slotModel(input, "sonnet", 1);
    const haiku = slotModel(input, "haiku", 2);
    const fable = slotModel(input, "fable", 3);
    const mythos = slotModel(input, "mythos", 4);
    if (opus !== undefined) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
    if (sonnet !== undefined) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
    if (haiku !== undefined) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
    if (fable !== undefined) env.ANTHROPIC_DEFAULT_FABLE_MODEL = fable;
    if (mythos !== undefined) env.ANTHROPIC_DEFAULT_MODEL = mythos;
    if (input.activeModel) env.ANTHROPIC_MODEL = input.activeModel;
    settings.env = env;
    settings.hasCompletedOnboarding = true;
    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Claude Code settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = settingsPath();
    const settings = (await readJsonFile(path)) as { env?: Record<string, unknown> } | null;
    if (!settings) return { success: true, message: "No settings file to reset" };
    if (settings.env) {
      for (const key of envKeys()) delete settings.env[key];
    }
    await writeJsonFile(path, settings);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Claude Code" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: stripV1Suffix(input.endpoint),
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
      API_TIMEOUT_MS: "600000",
    };
    const opus = slotModel(input, "opus", 0);
    const sonnet = slotModel(input, "sonnet", 1);
    const haiku = slotModel(input, "haiku", 2);
    const fable = slotModel(input, "fable", 3);
    const mythos = slotModel(input, "mythos", 4);
    if (opus !== undefined) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
    if (sonnet !== undefined) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
    if (haiku !== undefined) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
    if (fable !== undefined) env.ANTHROPIC_DEFAULT_FABLE_MODEL = fable;
    if (mythos !== undefined) env.ANTHROPIC_DEFAULT_MODEL = mythos;
    if (input.activeModel) env.ANTHROPIC_MODEL = input.activeModel;
    const content = JSON.stringify({ hasCompletedOnboarding: true, env }, null, 2);
    return { content, filename: "settings.json", mimeType: "application/json" };
  },
};
