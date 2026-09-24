import type {} from "../contracts";
import { ensureV1Suffix, homeDir, readJsonFile, readTextFile, removeFile, textGet, textHas, textRemove, textUpsert, writeJsonFile, writeTextFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Codex injector spec.
const CODEX_PROVIDER = "cartethyia";
const CODEX_AUTH_HELPER_NAME = "cartethyia-auth.cjs";
const CODEX_AUTH_HELPER_SOURCE = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const auth = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth.json'), 'utf8'));",
  "const key = auth.cartethyia;",
  "if (typeof key === 'string') process.stdout.write(key);",
  "",
].join("\n");

const codexAuthPath = () => `${homeDir()}/.codex/auth.json`;
const codexAuthHelperPath = () => `${homeDir()}/.codex/${CODEX_AUTH_HELPER_NAME}`;
const codexAuthHelperConfigPath = () => codexAuthHelperPath().replaceAll("\\", "/");

export const codexSpec: InjectorSpec = {
  toolId: "codex",
  displayName: "Codex CLI",
  binary: "codex",
  keepSettingsPathOnMissing: true,
  resetEvenIfMissing: true,
  resolvePath: () => `${homeDir()}/.codex/config.toml`,
  resolveDir: () => `${homeDir()}/.codex`,

  async readStatus(path) {
    const text = await readTextFile(path);
    if (!text) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const baseUrl = textGet(text, { kind: "flat", key: "base_url" });
    const model = textGet(text, { kind: "flat", key: "model" });
    const auth = (await readJsonFile(codexAuthPath())) as Record<string, string> | null;
    const apiKey = auth?.[CODEX_PROVIDER] ?? null;
    return {
      configured: textHas(text, { kind: "section", section: `model_providers.${CODEX_PROVIDER}` }),
      currentEndpoint: baseUrl,
      rawApiKey: apiKey,
      currentModels: model ? [model] : null,
    };
  },

  async apply(input, path) {
    const model = input.modelSlots?.session ?? input.activeModel ?? input.modelIds[0] ?? "";
    const subagent = input.modelSlots?.subagent ?? input.subagentModel ?? model;
    const review = input.modelSlots?.review;
    const baseUrl = ensureV1Suffix(input.endpoint);

    let text = (await readTextFile(path)) ?? "";
    text = textRemove(text, { kind: "flat", key: "model" });
    text = textRemove(text, { kind: "flat", key: "review_model" });
    text = textRemove(text, { kind: "flat", key: "model_provider" });
    text = textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, model);
    if (review !== undefined)
      text = textUpsert(text, { kind: "flat", key: "review_model", insertAtTop: true }, review);
    text = textUpsert(
      text,
      { kind: "flat", key: "model_provider", insertAtTop: true },
      CODEX_PROVIDER,
    );
    text = textRemove(text, { kind: "section", section: `model_providers.${CODEX_PROVIDER}.auth` });
    text = textUpsert(
      text,
      { kind: "section", section: `model_providers.${CODEX_PROVIDER}` },
      [`  name = "Cartethyia"`, `  base_url = "${baseUrl}"`, `  wire_api = "responses"`].join("\n"),
    );
    text = textUpsert(
      text,
      { kind: "sectionKey", section: "agents", key: "default_subagent_model" },
      subagent,
    );
    text = textRemove(text, { kind: "section", section: `model_providers.${CODEX_PROVIDER}.auth` });
    text = textUpsert(
      text,
      { kind: "section", section: `model_providers.${CODEX_PROVIDER}.auth` },
      [
        `  command = "node"`,
        `  args = ["${codexAuthHelperConfigPath()}"]`,
        `  timeout_ms = 5000`,
        `  refresh_interval_ms = 0`,
      ].join("\n"),
    );
    await writeTextFile(path, text);

    const auth = ((await readJsonFile(codexAuthPath())) as Record<string, string> | null) ?? {};
    auth[CODEX_PROVIDER] = input.apiKey;
    await writeJsonFile(codexAuthPath(), auth);
    await writeTextFile(codexAuthHelperPath(), CODEX_AUTH_HELPER_SOURCE);
  },

  async reset(path) {
    let text = await readTextFile(path);
    if (!text) {
      await removeFile(codexAuthHelperPath());
      return false;
    }
    text = textRemove(text, { kind: "section", section: `model_providers.${CODEX_PROVIDER}.auth` });
    text = textRemove(text, { kind: "section", section: `model_providers.${CODEX_PROVIDER}` });
    text = textRemove(text, {
      kind: "sectionKey",
      section: "agents",
      key: "default_subagent_model",
    });
    text = textRemove(text, { kind: "section", section: "agents.subagent" });
    if (textGet(text, { kind: "flat", key: "model_provider" }) === CODEX_PROVIDER) {
      text = textUpsert(text, { kind: "flat", key: "model_provider", insertAtTop: true }, "openai");
    }
    await writeTextFile(path, text);

    const auth = (await readJsonFile(codexAuthPath())) as Record<string, string> | null;
    if (auth?.[CODEX_PROVIDER]) {
      delete auth[CODEX_PROVIDER];
      await writeJsonFile(codexAuthPath(), auth);
    }
    await removeFile(codexAuthHelperPath());
  },

  download(input) {
    const model = input.modelSlots?.session ?? input.activeModel ?? input.modelIds[0] ?? "";
    const subagent = input.modelSlots?.subagent ?? input.subagentModel ?? model;
    const review = input.modelSlots?.review;
    const baseUrl = ensureV1Suffix(input.endpoint);
    const reviewLine = review === undefined ? "" : `review_model = "${review}"\n`;
    const toml = [
      `model = "${model}"`,
      reviewLine.trimEnd(),
      `model_provider = "${CODEX_PROVIDER}"`,
      "",
      `[model_providers.${CODEX_PROVIDER}]`,
      `  name = "Cartethyia"`,
      `  base_url = "${baseUrl}"`,
      `  wire_api = "responses"`,
      "",
      `[model_providers.${CODEX_PROVIDER}.auth]`,
      `  command = "node"`,
      `  args = ["${codexAuthHelperConfigPath()}"]`,
      `  timeout_ms = 5000`,
      `  refresh_interval_ms = 0`,
      "",
      "[agents]",
      `  default_subagent_model = "${subagent}"`,
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    const authJson = JSON.stringify({ [CODEX_PROVIDER]: input.apiKey }, null, 2);
    return {
      content: [
        "# config.toml",
        toml,
        "# auth.json",
        authJson,
        `# ${CODEX_AUTH_HELPER_NAME} (save this script as ~/.codex/${CODEX_AUTH_HELPER_NAME})`,
        CODEX_AUTH_HELPER_SOURCE,
        "",
      ].join("\n"),
      filename: "codex-config.txt",
      mimeType: "text/plain",
    };
  },

  messages: {
    applied: "Codex CLI settings applied",
    reset: "Cartethyia settings removed from Codex",
    resetMissing: "No config file to reset",
  },
};

