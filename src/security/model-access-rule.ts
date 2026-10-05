/**
 * The API-key model-access rule: one mode, one list.
 *
 * Kept pure — no database, no Node builtins, no Elysia — because three very
 * different callers must agree on it exactly:
 *
 *  - the request path (`transport/request/preparer.ts`) and admission
 *    (`security/admission/service.ts`) enforce it server-side;
 *  - the discovery surfaces (`/v1/models`, the share page) filter by it;
 *  - the dashboard's CLI-mapping page previews it to warn about a mapping the
 *    key is not allowed to reach, and the dashboard cannot import the Node-side
 *    `api-key-auth` module graph.
 *
 * One definition means a preview can never disagree with enforcement.
 */
import type { ApiKeyModelAccessMode } from "../persistence/schema";

/**
 * The two model-authorization rejection reasons. They are indistinguishable on
 * the wire (both 404 `model_not_found`) and in the admission metric label; only
 * the error's `details.reason` distinguishes a denylist hit from an allowlist
 * miss, so this vocabulary has exactly one definition.
 */
export type ModelRejectionReason = "model-denied" | "model-not-allowed";

/** The subset of an authorization snapshot this rule reads. */
export interface ModelAccessPolicy {
  readonly model_access_mode?: ApiKeyModelAccessMode | null | undefined;
  readonly model_list?: readonly string[] | ReadonlySet<string> | null | undefined;
}

/** Membership test over a list that may be an array, a Set, or absent. */
export function listIncludes(
  list: readonly string[] | ReadonlySet<string> | null | undefined,
  value: string,
): boolean {
  if (list == null) return false;
  if (list instanceof Set) return list.has(value);
  return (list as readonly string[]).includes(value);
}

function listSize(list: readonly string[] | ReadonlySet<string> | null | undefined): number {
  if (list == null) return 0;
  if (list instanceof Set) return list.size;
  return (list as readonly string[]).length;
}

/** Bare model id behind an optional `provider/` qualifier. */
function bareModelId(targetModel: string): string {
  const slash = targetModel.lastIndexOf("/");
  return slash < 0 ? targetModel : targetModel.slice(slash + 1);
}

/**
 * Single source of truth for the API-key model access rule. Returns the
 * rejection reason, or `null` when the target model is authorized.
 *
 * Two modes, one list (`policy.model_access_mode` / `policy.model_list`):
 *
 *  - `whitelist` — only a listed name may be used; an empty list allows every
 *    model (the deployment default).
 *  - `blacklist` — a listed name is refused; an empty list refuses nothing.
 *
 * Matching is exact for qualified names. A bare entry matches a qualified
 * target only when the bare entry is itself the request's usable name; a
 * qualified alias entry does not authorize unrelated provider routes that
 * happen to share the same final path segment. When an alias request is
 * present, it is checked explicitly through `requestedModel`.
 *
 * There is deliberately NO escape hatch for CLI remapping. A remapped request
 * is authorized only when the caller's own requested name (`requestedModel`) or
 * the resolved target is allowed — a CLI mapping can no longer launder access
 * to a model the key is not allowed to reach. The CLI mapping page surfaces a
 * warning and a one-click fix for a mapping that is no longer authorized.
 */
export function modelRejectionReason(
  policy: ModelAccessPolicy,
  targetModel: string,
  targetProvider?: string,
  requestedModel?: string,
): ModelRejectionReason | null {
  const qualified = targetProvider ? `${targetProvider}/${bareModelId(targetModel)}` : undefined;
  const names = [targetModel, bareModelId(targetModel), ...(qualified ? [qualified] : [])];
  if (requestedModel && requestedModel !== targetModel) names.push(requestedModel);
  const list = policy.model_list;
  if (policy.model_access_mode === "blacklist") {
    // Denial matches every name the request carries — the resolved target, its
    // bare form, the qualified form when the provider is known, and the name the
    // caller asked for. Denying an alias (`fast`) must refuse a request that
    // names it, and denying a target must refuse a request that resolves to it,
    // so neither direction can slip through.
    return names.some((name) => listIncludes(list, name)) ? "model-denied" : null;
  }
  if (list == null || listSize(list) === 0) return null;
  if (names.some((name) => listIncludes(list, name))) return null;
  return "model-not-allowed";
}

export function isModelAllowed(
  policy: ModelAccessPolicy,
  targetModel: string,
  targetProvider?: string,
  requestedModel?: string,
): boolean {
  return modelRejectionReason(policy, targetModel, targetProvider, requestedModel) === null;
}
