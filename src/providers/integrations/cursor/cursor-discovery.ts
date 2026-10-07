/**
 * Live Cursor model discovery.
 *
 * `GetUsableModels` answers with the models the credential's plan reaches, so
 * the static catalog is only the offline seed and discovery needs the
 * credential. A failed call returns null rather than the seed: the seeder
 * keeps the existing rows, and a transient upstream error must not wipe them.
 */
import type { ModelDefinition } from "../../model-definition";
import type { ProviderModelDiscovery } from "../../discovery/discovery-types";
import { cursorModel } from "./cursor-catalog";
import { decodeUsableModels } from "./cursor-messages";
import { CURSOR_MODELS_PATH, unaryCall } from "./cursor-transport";

const CLIENT_VERSION = "cli-2026.08.11";

export const fetchCursorModels: ProviderModelDiscovery = async (context): Promise<readonly ModelDefinition[] | null> => {
  const token = context.credential.trim();
  if (!token) return null;
  try {
    const result = await unaryCall(CURSOR_MODELS_PATH, new Uint8Array(), {
      token,
      clientVersion: CLIENT_VERSION,
    });
    if (!result.payload) return null;
    const models = decodeUsableModels(result.payload);
    if (models.length === 0) return null;
    return models.map((model) => cursorModel(model.modelId));
  } catch {
    return null;
  }
};
