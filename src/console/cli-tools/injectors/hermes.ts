import type {} from "../contracts";
import { ensureV1Suffix, homeDir, isLocalEndpoint, readTextFile, textGet, textRemove, textUpsert, writeTextFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Hermes Agent injector spec.
const HERMES_MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

function parseHermesModelBlock(
  yaml: string,
): { default: string | null; provider: string | null; base_url: string | null } | null {
  const match = yaml.match(HERMES_MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] ?? "";
  const get = (key: string): string | null => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? (m[1] ?? "").trim() : null;
  };
  return { default: get("default"), provider: get("provider"), base_url: get("base_url") };
}

const hermesEnvPath = () => `${homeDir()}/.hermes/.env`;

export const hermesSpec: InjectorSpec = {
  toolId: "hermes",
  displayName: "Hermes Agent",
  binary: "hermes",
  resolvePath: () => `${homeDir()}/.hermes/config.yaml`,
  resolveDir: () => `${homeDir()}/.hermes`,

  async readStatus(path) {
    const text = await readTextFile(path);
    if (!text) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const model = parseHermesModelBlock(text);
    const baseUrl = model?.base_url ?? null;
    const envText = await readTextFile(hermesEnvPath());
    const apiKey = envText
      ? textGet(envText, { kind: "flat", key: "OPENAI_API_KEY", format: "env" })
      : null;
    const configured = model?.provider === "custom" && isLocalEndpoint(baseUrl);
    return {
      configured,
      currentEndpoint: baseUrl,
      rawApiKey: apiKey,
      currentModels: model?.default ? [model.default] : null,
    };
  },

  async apply(input, path) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const block = `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n`;

    let yaml = (await readTextFile(path)) ?? "";
    yaml = HERMES_MODEL_BLOCK_RE.test(yaml)
      ? yaml.replace(HERMES_MODEL_BLOCK_RE, block)
      : yaml.length > 0
        ? `${block}\n${yaml}`
        : block;
    await writeTextFile(path, yaml);

    let envText = (await readTextFile(hermesEnvPath())) ?? "";
    envText = textUpsert(
      envText,
      { kind: "flat", key: "OPENAI_API_KEY", format: "env" },
      input.apiKey,
    );
    await writeTextFile(hermesEnvPath(), envText);
  },

  async reset(path) {
    const yaml = await readTextFile(path);
    if (yaml) {
      await writeTextFile(path, yaml.replace(HERMES_MODEL_BLOCK_RE, "").replace(/^\n+/, ""));
    }
    const envText = await readTextFile(hermesEnvPath());
    if (envText) {
      await writeTextFile(
        hermesEnvPath(),
        textRemove(envText, { kind: "flat", key: "OPENAI_API_KEY", format: "env" }),
      );
    }
  },

  download(input) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = ensureV1Suffix(input.endpoint);
    const yaml = `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n`;
    const envFile = `OPENAI_API_KEY=${input.apiKey}\n`;
    return {
      content: `# ~/.hermes/config.yaml\n${yaml}\n# ~/.hermes/.env\n${envFile}`,
      filename: "hermes-config.txt",
      mimeType: "text/plain",
    };
  },

  messages: {
    applied: "Hermes Agent settings applied",
    reset: "Cartethyia settings removed from Hermes Agent",
  },
};

