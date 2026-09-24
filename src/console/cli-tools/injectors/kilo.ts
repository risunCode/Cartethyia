import { platform } from "node:os";
import type {} from "../contracts";
import { ensureV1Suffix, homeDir, isLocalEndpoint, join, readJsonFile, writeJsonFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

// Kilo Code injector spec.
function resolveKiloDataDirectory(): string {
  if (IS_WIN) return join(process.env.LOCALAPPDATA ?? homeDir(), "kilo");
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", "kilo");
  return join(homeDir(), ".local", "share", "kilo");
}

function kiloVscodeSettingsPath(): string {
  if (IS_WIN) return join(process.env.APPDATA ?? homeDir(), "Code", "User", "settings.json");
  if (IS_MAC)
    return join(homeDir(), "Library", "Application Support", "Code", "User", "settings.json");
  return join(homeDir(), ".config", "Code", "User", "settings.json");
}

export const kiloSpec: InjectorSpec = {
  toolId: "kilo",
  displayName: "Kilo Code",
  binary: "kilo",
  resolveDir: resolveKiloDataDirectory,
  resolvePath: () => join(resolveKiloDataDirectory(), "auth.json"),

  async readStatus(path) {
    const auth = (await readJsonFile(path)) as Record<
      string,
      { baseUrl?: string; baseURL?: string; apiKey?: string; model?: string }
    > | null;
    const entry = auth?.["openai-compatible"];
    if (!entry) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const baseUrl = entry.baseUrl ?? entry.baseURL ?? null;
    return {
      configured: isLocalEndpoint(baseUrl),
      currentEndpoint: baseUrl,
      rawApiKey: entry.apiKey ?? null,
      currentModels: entry.model ? [entry.model] : null,
    };
  },

  async apply(input, path) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const auth = ((await readJsonFile(path)) as Record<string, unknown> | null) ?? {};
    auth["openai-compatible"] = { baseUrl, apiKey: input.apiKey, model };
    await writeJsonFile(path, auth);

    const settings =
      ((await readJsonFile(kiloVscodeSettingsPath())) as Record<string, unknown> | null) ?? {};
    settings["kilo.code.authProviderOverride"] = "openai-compatible";
    await writeJsonFile(kiloVscodeSettingsPath(), settings);
  },

  async reset(path) {
    const auth = (await readJsonFile(path)) as Record<string, unknown> | null;
    if (!auth) return false;
    delete auth["openai-compatible"];
    await writeJsonFile(path, auth);

    const settings = (await readJsonFile(kiloVscodeSettingsPath())) as Record<
      string,
      unknown
    > | null;
    if (settings && "kilo.code.authProviderOverride" in settings) {
      delete settings["kilo.code.authProviderOverride"];
      await writeJsonFile(kiloVscodeSettingsPath(), settings);
    }
  },

  download(input) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    return {
      content: JSON.stringify(
        {
          "openai-compatible": { baseUrl, apiKey: input.apiKey, model },
        },
        null,
        2,
      ),
      filename: "auth.json",
      mimeType: "application/json",
    };
  },

  messages: {
    applied: "Kilo Code settings applied",
    reset: "Cartethyia settings removed from Kilo Code",
    resetMissing: "No auth file to reset",
  },
};

