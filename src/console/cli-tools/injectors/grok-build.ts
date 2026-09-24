import type {} from "../contracts";
import { checkBinaryInstalled, ensureV1Suffix, homeDir, readTextFile, textGet, textHas, textRemove, textUpsert, writeTextFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Grok Build injector spec.
function grokModelSectionBody(model: string, baseUrl: string, apiKey: string): string {
  const lines = [`default = "${model}"`, `base_url = "${baseUrl}"`, `provider = "custom"`];
  if (apiKey) lines.push(`api_key = "${apiKey}"`);
  return lines.join("\n");
}

export const grokBuildSpec: InjectorSpec = {
  toolId: "grok-build",
  displayName: "Grok Build",
  checkInstalled: async () => {
    return checkBinaryInstalled("grok");
  },
  resolvePath: () => `${homeDir()}/.grok/config.toml`,
  resolveDir: () => `${homeDir()}/.grok`,

  async readStatus(path) {
    const text = await readTextFile(path);
    if (!text) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const baseUrl = textGet(text, { kind: "flat", key: "base_url" });
    const model = textGet(text, { kind: "flat", key: "default" });
    const apiKey = textGet(text, { kind: "flat", key: "api_key" });
    const configured = textHas(text, { kind: "section", section: "model" }) && baseUrl !== null;
    return {
      configured,
      currentEndpoint: baseUrl,
      rawApiKey: apiKey,
      currentModels: model ? [model] : null,
    };
  },

  async apply(input, path) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    let text = (await readTextFile(path)) ?? "";
    text = textUpsert(
      text,
      { kind: "section", section: "model" },
      grokModelSectionBody(model, baseUrl, input.apiKey),
    );
    await writeTextFile(path, text);
  },

  async reset(path) {
    let text = await readTextFile(path);
    if (!text) return false;
    text = textRemove(text, { kind: "section", section: "model" });
    await writeTextFile(path, text);
  },

  download(input) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const body = grokModelSectionBody(model, baseUrl, input.apiKey);
    return {
      content: `[model]\n${body}\n`,
      filename: "grok-config.toml",
      mimeType: "text/plain",
    };
  },

  messages: {
    applied: "Grok Build settings applied",
    reset: "Cartethyia settings removed from Grok Build",
    resetMissing: "No config file to reset",
  },
};

