import type {} from "../contracts";
import { ensureDir, ensureV1Suffix, homeDir, isLocalEndpoint, join, readTextFile, textGet, textHas, textRemove, textUpsert, writeTextFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Jcode injector spec.
function jcodeEnvFileDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homeDir(), ".config"), "jcode");
}

function jcodeEnvFilePath(): string {
  return join(jcodeEnvFileDir(), "provider-cartethyia.env");
}

export const jcodeSpec: InjectorSpec = {
  toolId: "jcode",
  displayName: "jcode",
  binary: "jcode",
  resolvePath: () => join(homeDir(), ".jcode", "config.toml"),
  resolveDir: () => join(homeDir(), ".jcode"),

  async readStatus(path) {
    const text = await readTextFile(path);
    if (!text) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const configured = textHas(text, { kind: "section", section: "providers.cartethyia" });
    const baseUrl = textGet(text, { kind: "flat", key: "base_url" });
    const envText = await readTextFile(jcodeEnvFilePath());
    const apiKey = envText
      ? textGet(envText, { kind: "flat", key: "OPENAI_API_KEY", format: "env" })
      : null;
    return {
      configured,
      currentEndpoint: isLocalEndpoint(baseUrl) ? baseUrl : null,
      rawApiKey: apiKey,
      currentModels: null,
    };
  },

  async apply(input, path) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);

    let text = (await readTextFile(path)) ?? "";
    text = textUpsert(
      text,
      { kind: "section", section: "providers.cartethyia" },
      [
        `  type = "openai"`,
        `  base_url = "${baseUrl}"`,
        `  env_file = "provider-cartethyia.env"`,
        `  model = "${model}"`,
      ].join("\n"),
    );
    await writeTextFile(path, text);

    await ensureDir(jcodeEnvFileDir());
    let envText = (await readTextFile(jcodeEnvFilePath())) ?? "";
    envText = textUpsert(
      envText,
      { kind: "flat", key: "OPENAI_API_KEY", format: "env" },
      input.apiKey,
    );
    await writeTextFile(jcodeEnvFilePath(), envText);
  },

  async reset(path) {
    let text = await readTextFile(path);
    if (text) {
      text = textRemove(text, { kind: "section", section: "providers.cartethyia" });
      await writeTextFile(path, text);
    }
    const envText = await readTextFile(jcodeEnvFilePath());
    if (envText) {
      await writeTextFile(
        jcodeEnvFilePath(),
        textRemove(envText, { kind: "flat", key: "OPENAI_API_KEY", format: "env" }),
      );
    }
  },

  download(input) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const toml = [
      `[providers.cartethyia]`,
      `  type = "openai"`,
      `  base_url = "${baseUrl}"`,
      `  env_file = "provider-cartethyia.env"`,
      `  model = "${model}"`,
      "",
    ].join("\n");
    const envFile = `OPENAI_API_KEY=${input.apiKey}\n`;
    return {
      content: `# config.toml\n${toml}\n# provider-cartethyia.env\n${envFile}`,
      filename: "jcode-config.txt",
      mimeType: "text/plain",
    };
  },

  messages: {
    applied: "jcode settings applied",
    reset: "Cartethyia settings removed from jcode",
  },
};

