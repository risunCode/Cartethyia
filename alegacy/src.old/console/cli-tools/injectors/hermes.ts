/**
 * Hermes Agent injector — writes only the provider endpoint/model block.
 *
 * Cartethyia owns provider credentials in its provider configuration and
 * secret store. This legacy injector never writes or reads provider secret
 * environment variables.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  homeDir,
  isLocalEndpoint,
  join,
  readTextFile,
  writeTextFile,
} from "../fs-ops";

/** Match a top-level `model:` block (until the next indented block ends). */
const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

function hermesDir(): string {
  return join(homeDir(), ".hermes");
}

function configPath(): string {
  return join(hermesDir(), "config.yaml");
}

function buildModelBlock(model: string, baseUrl: string): string {
  return `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n`;
}

function parseModelBlock(yaml: string): { default: string | null; provider: string | null; base_url: string | null } | null {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] ?? "";
  const get = (key: string): string | null => {
    const value = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return value ? (value[1] ?? "").trim() : null;
  };
  return { default: get("default"), provider: get("provider"), base_url: get("base_url") };
}

function upsertModelBlock(yaml: string, block: string): string {
  return MODEL_BLOCK_RE.test(yaml) ? yaml.replace(MODEL_BLOCK_RE, block) : yaml.length > 0 ? `${block}\n${yaml}` : block;
}

function removeModelBlock(yaml: string): string {
  return yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");
}

export const hermesInjector: ToolInjector = {
  toolId: "hermes",

  async getStatus(): Promise<ToolStatus> {
    const path = configPath();
    const installed = await checkBinaryInstalled("hermes", path);
    if (!installed) {
      return { toolId: "hermes", installed: false, configured: false, settingsPath: null, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const text = await readTextFile(path);
    if (!text) {
      return { toolId: "hermes", installed: true, configured: false, settingsPath: path, currentEndpoint: null, currentApiKeyPrefix: null, currentModels: null };
    }
    const model = parseModelBlock(text);
    const baseUrl = model?.base_url ?? null;
    return {
      toolId: "hermes",
      installed: true,
      configured: model?.provider === "custom" && isLocalEndpoint(baseUrl),
      settingsPath: path,
      currentEndpoint: baseUrl,
      currentApiKeyPrefix: null,
      currentModels: model?.default ? [model.default] : null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    await ensureDir(hermesDir());
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    let yaml = (await readTextFile(configPath())) ?? "";
    yaml = upsertModelBlock(yaml, buildModelBlock(model, baseUrl));
    await writeTextFile(configPath(), yaml);
    return { success: true, settingsPath: configPath(), message: "Hermes Agent provider settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    const yaml = await readTextFile(path);
    if (yaml) await writeTextFile(path, removeModelBlock(yaml));
    return { success: true, settingsPath: path, message: "Cartethyia provider settings removed from Hermes Agent" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    return { content: `# ~/.hermes/config.yaml\n${buildModelBlock(model, baseUrl)}`, filename: "hermes-config.yaml", mimeType: "text/yaml" };
  },
};
