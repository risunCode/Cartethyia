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
  ensureV1Suffix,
  homeDir,
  isLocalEndpoint,
  keyPrefix,
  readJsonFile,
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
    "API_TIMEOUT_MS",
  ];
}

export const claudeInjector: ToolInjector = {
  toolId: "claude",

  async getStatus(): Promise<ToolStatus> {
    const path = settingsPath();
    const installed = await checkBinaryInstalled("claude", path);
    if (!installed) {
      return { toolId: "claude", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const settings = (await readJsonFile(path)) as { env?: Record<string, string> } | null;
    const env = settings?.env;
    const endpoint = env?.ANTHROPIC_BASE_URL ?? null;
    const apiKey = env?.ANTHROPIC_AUTH_TOKEN ?? null;
    const models = env ? [env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter((m): m is string => typeof m === "string") : null;
    return {
      toolId: "claude",
      installed: true,
      configured: isLocalEndpoint(endpoint),
      settingsPath: path,
      currentEndpoint: endpoint ?? null,
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
    env.ANTHROPIC_BASE_URL = ensureV1Suffix(input.endpoint);
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
    env.API_TIMEOUT_MS = "600000";
    // Map models to Claude's env slots — input.models[0] = opus, [1] = sonnet, [2] = haiku.
    if (input.models.length > 0) env.ANTHROPIC_DEFAULT_OPUS_MODEL = input.models[0]!;
    if (input.models.length > 1) env.ANTHROPIC_DEFAULT_SONNET_MODEL = input.models[1]!;
    if (input.models.length > 2) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.models[2]!;
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
      ANTHROPIC_BASE_URL: ensureV1Suffix(input.endpoint),
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
      API_TIMEOUT_MS: "600000",
    };
    if (input.models.length > 0) env.ANTHROPIC_DEFAULT_OPUS_MODEL = input.models[0]!;
    if (input.models.length > 1) env.ANTHROPIC_DEFAULT_SONNET_MODEL = input.models[1]!;
    if (input.models.length > 2) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.models[2]!;
    if (input.activeModel) env.ANTHROPIC_MODEL = input.activeModel;
    const content = JSON.stringify({ hasCompletedOnboarding: true, env }, null, 2);
    return { content, filename: "settings.json", mimeType: "application/json" };
  },
};
