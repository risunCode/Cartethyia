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

/**
 * Returns whether a catalog entry or requested model id is permitted for this
 * key. Allow/deny lists match the exact identifier the client sent (or the
 * catalog entry's exact id) — never the bare model-id tail of a qualified
 * entry. Matching the tail alone would let an allowlisted alias (e.g.
 * `gpt-5.6-sol`) transparently also permit the real qualified model it
 * resolves to (`openai/gpt-5.6-sol`), silently granting direct provider
 * access the key was never given and duplicating both entries in /v1/models.
 */
export function isModelAllowedForKey(key: ApiKeyPublic, model: string): boolean {
  const parsed = parseQualifiedModel(model);
  const providerId = parsed.kind === "qualified" ? parsed.model.provider : null;

  if (key.modelDenylist?.includes(model)) return false;

  if (key.providerAllowlist && providerId && !key.providerAllowlist.includes(providerId)) return false;

  if (key.modelAllowlist && !key.modelAllowlist.includes(model)) return false;

  return true;
}

export function filterModelsForKey<T extends { id: string }>(key: ApiKeyPublic, entries: T[]): T[] {
  return entries.filter((entry) => isModelAllowedForKey(key, entry.id));
}
