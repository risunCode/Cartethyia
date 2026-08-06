/**
 * Hermes Agent injector — writes ~/.hermes/config.yaml (YAML model block)
 * and ~/.hermes/.env (OPENAI_API_KEY).
 *
 * Hermes is a Nous Research self-improving agent that reads an
 * OpenAI-compatible endpoint from a top-level `model:` block in YAML:
 *
 *   model:
 *     default: "model-id"
 *     provider: "custom"
 *     base_url: "http://localhost:12800/v1"
 *
 * The `provider: "custom"` field is Hermes's own provider-type selector
 * (meaning "custom OpenAI-compatible endpoint"), not the Cartethyia provider
 * name, so it is kept verbatim from the 9router reference to match Hermes's
 * expected schema. We upsert/remove the whole `model:` block via regex so
 * all other YAML content is preserved.
 *
 * The API key lives in ~/.hermes/.env as OPENAI_API_KEY.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus } from "../types";
import {
  checkBinaryInstalled,
  ensureDir,
  ensureV1Suffix,
  envGet,
  envRemove,
  envUpsert,
  homeDir,
  isLocalEndpoint,
  join,
  keyPrefix,
  readTextFile,
  writeTextFile,
} from "../fs-ops";

const API_KEY_ENV = "OPENAI_API_KEY";

/** Match a top-level `model:` block (until the next non-indented, non-empty line). */
const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

function hermesDir(): string {
  return join(homeDir(), ".hermes");
}

function configPath(): string {
  return join(hermesDir(), "config.yaml");
}

function envPath(): string {
  return join(hermesDir(), ".env");
}

/** Build the `model:` block Hermes expects. */
function buildModelBlock(model: string, baseUrl: string): string {
  return `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n`;
}

/** Parse the current `model:` block back to its fields (best-effort). */
function parseModelBlock(yaml: string): { default: string | null; provider: string | null; base_url: string | null } | null {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] ?? "";
  const get = (key: string): string | null => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? (m[1] ?? "").trim() : null;
  };
  return { default: get("default"), provider: get("provider"), base_url: get("base_url") };
}

/** Replace an existing `model:` block, or prepend a new one. */
function upsertModelBlock(yaml: string, block: string): string {
  if (MODEL_BLOCK_RE.test(yaml)) return yaml.replace(MODEL_BLOCK_RE, block);
  return yaml.length > 0 ? `${block}\n${yaml}` : block;
}

/** Remove the `model:` block, collapsing any leading blank lines left behind. */
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
    const envText = await readTextFile(envPath());
    const apiKey = envText ? envGet(envText, API_KEY_ENV) : null;
    const configured = model?.provider === "custom" && isLocalEndpoint(baseUrl);
    return {
      toolId: "hermes",
      installed: true,
      configured,
      settingsPath: path,
      currentEndpoint: baseUrl,
      currentApiKeyPrefix: keyPrefix(apiKey),
      currentModels: model?.default ? [model.default] : null,
    };
  },

  async apply(input: ApplyInput): Promise<ApplyResult> {
    await ensureDir(hermesDir());
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);

    // config.yaml — upsert the model: block, preserve everything else.
    let yaml = (await readTextFile(configPath())) ?? "";
    yaml = upsertModelBlock(yaml, buildModelBlock(model, baseUrl));
    await writeTextFile(configPath(), yaml);

    // .env — upsert OPENAI_API_KEY.
    let envText = (await readTextFile(envPath())) ?? "";
    envText = envUpsert(envText, API_KEY_ENV, input.apiKey);
    await writeTextFile(envPath(), envText);

    return { success: true, settingsPath: configPath(), message: "Hermes Agent settings applied" };
  },

  async reset(): Promise<ApplyResult> {
    const path = configPath();
    const yaml = await readTextFile(path);
    if (yaml) {
      await writeTextFile(path, removeModelBlock(yaml));
    }
    const envText = await readTextFile(envPath());
    if (envText) {
      await writeTextFile(envPath(), envRemove(envText, API_KEY_ENV));
    }
    return { success: true, settingsPath: path, message: "Cartethyia settings removed from Hermes Agent" };
  },

  async download(input: ApplyInput): Promise<DownloadResult> {
    const model = input.activeModel ?? input.models[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const yaml = buildModelBlock(model, baseUrl);
    const envFile = `${API_KEY_ENV}=${input.apiKey}\n`;
    const content = `# ~/.hermes/config.yaml\n${yaml}\n# ~/.hermes/.env\n${envFile}`;
    return { content, filename: "hermes-config.txt", mimeType: "text/plain" };
  },
};
