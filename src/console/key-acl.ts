/**
 * API key model ACL — shared allow/deny logic for proxy auth and /v1/models.
 */

import { parseQualifiedModel } from "../routing/resolve";
import type { ApiKeyPublic } from "./db/repos/api-keys";

export function extractPresentedApiKey(request: Request): string {
  return request.headers.get("x-api-key") ??
    (request.headers.get("authorization")?.startsWith("Bearer ")
      ? request.headers.get("authorization")!.slice(7)
      : "");
}

/** Returns whether a catalog entry or requested model id is permitted for this key. */
export function isModelAllowedForKey(key: ApiKeyPublic, model: string): boolean {
  const parsed = parseQualifiedModel(model);
  const providerId = parsed.kind === "qualified" ? parsed.model.provider : null;
  const modelId = parsed.kind === "qualified" ? parsed.model.modelId : model;

  if (key.modelDenylist?.some((entry) => entry === modelId || entry === model)) return false;

  if (key.providerAllowlist && providerId && !key.providerAllowlist.includes(providerId)) return false;

  if (key.modelAllowlist && !key.modelAllowlist.includes(modelId) && !key.modelAllowlist.includes(model)) return false;

  return true;
}

export function filterModelsForKey<T extends { id: string }>(key: ApiKeyPublic, entries: T[]): T[] {
  return entries.filter((entry) => isModelAllowedForKey(key, entry.id));
}
