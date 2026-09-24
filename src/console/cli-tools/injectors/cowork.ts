import { platform } from "node:os";
import type {} from "../contracts";
import { fileExists, homeDir, join, readJsonFile, writeJsonFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

// Claude Cowork injector spec.
function coworkConfigDir(): string {
  if (IS_WIN) return join(process.env.APPDATA ?? homeDir(), "Claude", "configLibrary");
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", "Claude", "configLibrary");
  return join(homeDir(), ".config", "Claude", "configLibrary");
}

export const coworkSpec: InjectorSpec = {
  toolId: "cowork",
  displayName: "Claude Cowork",
  checkInstalled: (path) => fileExists(path),
  resolveDir: coworkConfigDir,
  resolvePath: () => join(coworkConfigDir(), "_meta.json"),

  async readStatus(path) {
    // Claude Cowork has no MCP bridge yet (the /mcp surface arrives in P3-2).
    // Report unconfigured instead of a phantom `cartethyia` managed server.
    void path;
    return {
      configured: false,
      currentEndpoint: null,
      rawApiKey: null,
      currentModels: null,
    };
  },

  async apply(input, path) {
    // Remove any previously-injected phantom `cartethyia` managed server. No
    // MCP bridge exists yet, so `apply` only cleans the stale key.
    void input;
    const meta = ((await readJsonFile(path)) as Record<string, unknown> | null) ?? {};
    if (typeof meta.managedServers === "object" && meta.managedServers !== null) {
      delete (meta.managedServers as Record<string, unknown>).cartethyia;
    }
    await writeJsonFile(path, meta);
  },

  async reset(path) {
    const meta = (await readJsonFile(path)) as { managedServers?: Record<string, unknown> } | null;
    if (!meta?.managedServers) return false;
    delete meta.managedServers.cartethyia;
    await writeJsonFile(path, meta);
  },

  download(input) {
    void input;
    return {
      content: JSON.stringify({ managedServers: {} }, null, 2),
      filename: "_meta.json",
      mimeType: "application/json",
    };
  },

  messages: {
    applied: "Claude Cowork settings applied",
    reset: "Cartethyia settings removed from Claude Cowork",
  },
};

