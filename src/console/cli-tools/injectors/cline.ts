import type {} from "../contracts";
import { homeDir, isLocalEndpoint, readJsonFile, stripV1Suffix, writeJsonFile } from "../fs-ops";
import type { InjectorSpec } from "../contracts";


// Cline injector spec.
interface ClineGlobalState {
  actModeApiProvider?: string;
  planModeApiProvider?: string;
  openAiBaseUrl?: string;
  openAiModelId?: string;
  planModeOpenAiModelId?: string;
  [key: string]: unknown;
}

interface ClineSecrets {
  openAiApiKey?: string;
  [key: string]: unknown;
}

const clineSecretsPath = () => `${homeDir()}/.cline/data/secrets.json`;

export const clineSpec: InjectorSpec = {
  toolId: "cline",
  displayName: "Cline",
  binary: "cline",
  resolvePath: () => `${homeDir()}/.cline/data/globalState.json`,
  resolveDir: () => `${homeDir()}/.cline/data`,

  async readStatus(path) {
    const state = (await readJsonFile(path)) as ClineGlobalState | null;
    const secrets = (await readJsonFile(clineSecretsPath())) as ClineSecrets | null;
    const endpoint = state?.openAiBaseUrl ?? null;
    const models = [state?.openAiModelId, state?.planModeOpenAiModelId].filter(
      (m): m is string => typeof m === "string",
    );
    const configured = state?.actModeApiProvider === "openai" && isLocalEndpoint(endpoint);
    return {
      configured,
      currentEndpoint: endpoint,
      rawApiKey: secrets?.openAiApiKey ?? null,
      currentModels: models.length > 0 ? models : null,
    };
  },

  async apply(input, path) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = stripV1Suffix(input.endpoint);

    const state = ((await readJsonFile(path)) as ClineGlobalState | null) ?? {};
    state.actModeApiProvider = "openai";
    state.planModeApiProvider = "openai";
    state.openAiBaseUrl = baseUrl;
    state.openAiModelId = model;
    state.planModeOpenAiModelId = model;
    await writeJsonFile(path, state);

    const secrets = ((await readJsonFile(clineSecretsPath())) as ClineSecrets | null) ?? {};
    secrets.openAiApiKey = input.apiKey;
    await writeJsonFile(clineSecretsPath(), secrets);
  },

  async reset(path) {
    const state = (await readJsonFile(path)) as ClineGlobalState | null;
    if (!state) return false;

    if (state.actModeApiProvider === "openai") {
      delete state.openAiBaseUrl;
      delete state.openAiModelId;
      delete state.planModeOpenAiModelId;
      state.actModeApiProvider = "cline";
      state.planModeApiProvider = "cline";
    }
    await writeJsonFile(path, state);

    const secrets = (await readJsonFile(clineSecretsPath())) as ClineSecrets | null;
    if (secrets?.openAiApiKey) {
      delete secrets.openAiApiKey;
      await writeJsonFile(clineSecretsPath(), secrets);
    }
  },

  download(input) {
    const model = input.activeModel ?? input.modelIds[0] ?? "";
    const baseUrl = stripV1Suffix(input.endpoint);
    const globalState = JSON.stringify(
      {
        actModeApiProvider: "openai",
        planModeApiProvider: "openai",
        openAiBaseUrl: baseUrl,
        openAiModelId: model,
        planModeOpenAiModelId: model,
      },
      null,
      2,
    );
    const secrets = JSON.stringify({ openAiApiKey: input.apiKey }, null, 2);
    return {
      content: `# ~/.cline/data/globalState.json\n${globalState}\n\n# ~/.cline/data/secrets.json\n${secrets}\n`,
      filename: "cline-config.txt",
      mimeType: "text/plain",
    };
  },

  messages: {
    applied: "Cline settings applied successfully",
    reset: "Cartethyia settings removed from Cline",
  },
};

