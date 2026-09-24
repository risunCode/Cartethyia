import type {} from "../contracts";
import { ensureV1Suffix, homeDir, isLocalEndpoint, readTextFile, textGet, textHas, textRemove, textUpsert, writeTextFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// DeepSeek TUI injector spec.
export const deepseekTuiSpec: InjectorSpec = {
  toolId: "deepseek-tui",
  displayName: "DeepSeek TUI",
  binary: "deepseek",
  resolvePath: () => `${homeDir()}/.deepseek/config.toml`,

  async readStatus(path) {
    const text = await readTextFile(path);
    if (!text) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const provider = textGet(text, { kind: "flat", key: "provider" });
    const baseUrl = textGet(text, { kind: "flat", key: "base_url" });
    const model = textGet(text, { kind: "flat", key: "model" });
    const configured =
      provider === "openai" &&
      textHas(text, { kind: "section", section: "providers.openai" }) &&
      isLocalEndpoint(baseUrl);
    return {
      configured,
      currentEndpoint: baseUrl,
      rawApiKey: textGet(text, { kind: "flat", key: "api_key" }),
      currentModels: model ? [model] : null,
    };
  },

  async apply(input, path) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    let text = (await readTextFile(path)) ?? "";
    text = textUpsert(text, { kind: "flat", key: "provider" }, "openai");
    text = textUpsert(
      text,
      { kind: "section", section: "providers.openai" },
      [`  base_url = "${baseUrl}"`, `  api_key = "${input.apiKey}"`, `  model = "${model}"`].join(
        "\n",
      ),
    );
    await writeTextFile(path, text);
  },

  async reset(path) {
    let text = await readTextFile(path);
    if (!text) return false;
    text = textRemove(text, { kind: "section", section: "providers.openai" });
    text = textUpsert(text, { kind: "flat", key: "provider" }, "deepseek");
    await writeTextFile(path, text);
  },

  download(input) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const content = [
      `provider = "openai"`,
      "",
      "[providers.openai]",
      `  base_url = "${baseUrl}"`,
      `  api_key = "${input.apiKey}"`,
      `  model = "${model}"`,
      "",
    ].join("\n");
    return { content, filename: "config.toml", mimeType: "text/plain" };
  },

  messages: {
    applied: "DeepSeek TUI settings applied",
    reset: "Cartethyia settings removed from DeepSeek TUI",
    resetMissing: "No config file to reset",
  },
};

