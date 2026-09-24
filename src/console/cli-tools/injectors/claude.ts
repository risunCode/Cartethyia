import type {} from "../contracts";
import { homeDir, isLocalEndpoint, readJsonFile, stripV1Suffix, writeJsonFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Claude Code injector spec.
const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "API_TIMEOUT_MS",
] as const;

export const claudeSpec: InjectorSpec = {
  toolId: "claude",
  displayName: "Claude Code",
  binary: "claude",
  keepSettingsPathOnMissing: true,
  resolvePath: () => `${homeDir()}/.claude/settings.json`,
  resolveDir: () => `${homeDir()}/.claude`,

  async readStatus(path) {
    const settings = (await readJsonFile(path)) as { env?: Record<string, string> } | null;
    const env = settings?.env;
    const endpoint = env?.ANTHROPIC_BASE_URL ?? null;
    const models = env
      ? [
          env.ANTHROPIC_DEFAULT_OPUS_MODEL,
          env.ANTHROPIC_DEFAULT_SONNET_MODEL,
          env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          env.ANTHROPIC_DEFAULT_FABLE_MODEL,
          env.ANTHROPIC_DEFAULT_MODEL,
        ].filter((m): m is string => typeof m === "string")
      : null;
    return {
      configured: isLocalEndpoint(endpoint),
      currentEndpoint: endpoint,
      rawApiKey: env?.ANTHROPIC_AUTH_TOKEN ?? null,
      currentModels: models,
    };
  },

  async apply(input, path) {
    const existing = (await readJsonFile(path)) as Record<string, unknown> | null;
    const settings = (existing ?? {}) as Record<string, unknown>;
    const env = (settings.env as Record<string, string> | undefined) ?? {};
    for (const key of CLAUDE_ENV_KEYS) {
      if (key !== "ANTHROPIC_BASE_URL" && key !== "ANTHROPIC_AUTH_TOKEN") delete env[key];
    }
    env.ANTHROPIC_BASE_URL = stripV1Suffix(input.endpoint);
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
    delete settings.model;
    delete settings.smallModel;
    if (input.bypassPermissions === true) {
      const permissions =
        typeof settings.permissions === "object" &&
        settings.permissions !== null &&
        !Array.isArray(settings.permissions)
          ? (settings.permissions as Record<string, unknown>)
          : {};
      permissions.defaultMode = "bypassPermissions";
      settings.permissions = permissions;
      settings.skipDangerousModePermissionPrompt = true;
    }
    settings.env = env;
    settings.hasCompletedOnboarding = true;
    await writeJsonFile(path, settings);
  },

  async reset(path) {
    const settings = (await readJsonFile(path)) as Record<string, unknown> | null;
    if (!settings) return false;
    const env = settings.env;
    if (env !== null && typeof env === "object" && !Array.isArray(env)) {
      for (const key of CLAUDE_ENV_KEYS) delete (env as Record<string, unknown>)[key];
    }
    delete settings.model;
    delete settings.smallModel;
    await writeJsonFile(path, settings);
  },

  download(input) {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: stripV1Suffix(input.endpoint),
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
    };
    const settings: Record<string, unknown> = { hasCompletedOnboarding: true, env };
    if (input.bypassPermissions === true) {
      settings.permissions = { defaultMode: "bypassPermissions" };
      settings.skipDangerousModePermissionPrompt = true;
    }
    return {
      content: JSON.stringify(settings, null, 2),
      filename: "settings.json",
      mimeType: "application/json",
    };
  },

  messages: {
    applied: "Claude Code settings applied",
    reset: "Cartethyia settings removed from Claude Code",
  },
};

