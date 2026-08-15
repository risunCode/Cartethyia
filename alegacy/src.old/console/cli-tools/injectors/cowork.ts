/**
 * Claude Cowork injector — writes to Claude Desktop's configLibrary/_meta.json
 * with MCP server bridge entries pointing at Cartethyia.
 *
 * Cowork is an MCP-based integration, not a standard env/config injection.
 * Cartethyia acts as an OpenAI-compatible endpoint, so we register an
 * MCP server entry in the Claude Desktop config that routes through us.
 *
 * Config paths (Claude Desktop app data):
 *   Windows: %APPDATA%/Claude/configLibrary/_meta.json
 *   macOS: ~/Library/Application Support/Claude/configLibrary/_meta.json
 *   Linux: ~/.config/Claude/configLibrary/_meta.json
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import { platform } from "node:os";
import {
  ensureDir,
  ensureV1Suffix,
  homeDir,
  join,
  keyPrefix,
  readJsonFile,
  writeJsonFile,
} from "../fs-ops";

const IS_WIN: boolean = platform() === "win32";
const IS_MAC: boolean = platform() === "darwin";

function configDir(): string {
  if (IS_WIN) return join(process.env.APPDATA ?? homeDir(), "Claude", "configLibrary");
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", "Claude", "configLibrary");
  return join(homeDir(), ".config", "Claude", "configLibrary");
}

function metaPath(): string {
  return join(configDir(), "_meta.json");
}

const PROVIDER = "cartethyia";

export const coworkInjector: ToolInjector = {
  toolId: "cowork",

  async getStatus(): Promise<ToolStatus> {
    const path = metaPath();
    const meta = (await readJsonFile(path)) as {
      managedServers?: Record<string, unknown>;
    } | null;
    if (!meta) {
      return { toolId: "cowork", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const servers = meta.managedServers ?? {};
    const entry = servers[PROVIDER] as { url?: string; apiKey?: string } | undefined;
    return {
      toolId: "cowork",
      installed: true,
      configured: !!entry,
      settingsPath: path,
      currentEndpoint: entry?.url ?? null,
      currentApiKeyPrefix: keyPrefix(entry?.apiKey),
      currentModels: null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const dir = configDir();
    await ensureDir(dir);
    const baseUrl = ensureV1Suffix(input.endpoint);
    const meta = ((await readJsonFile(metaPath())) as Record<string, unknown> | null) ?? {};
    if (typeof meta.managedServers !== "object" || meta.managedServers === null) meta.managedServers = {};
    const servers = meta.managedServers as Record<string, unknown>;
    servers[PROVIDER] = {
      url: `${baseUrl}/mcp`,
      apiKey: input.apiKey,
      type: "sse",
      enabled: true,
    };
    await writeJsonFile(metaPath(), meta);
    return { success: true, settingsPath: metaPath(), message: "Claude Cowork settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = metaPath();
    const meta = (await readJsonFile(path)) as { managedServers?: Record<string, unknown> } | null;
    if (!meta?.managedServers) return { success: true, message: "No settings file to reset" };
    delete meta.managedServers[PROVIDER];
    await writeJsonFile(path, meta);
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Claude Cowork" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const baseUrl = ensureV1Suffix(input.endpoint);
    const content = JSON.stringify({
      managedServers: {
        [PROVIDER]: {
          url: `${baseUrl}/mcp`,
          apiKey: input.apiKey,
          type: "sse",
          enabled: true,
        },
      },
    }, null, 2);
    return { content, filename: "_meta.json", mimeType: "application/json" };
  },
};
