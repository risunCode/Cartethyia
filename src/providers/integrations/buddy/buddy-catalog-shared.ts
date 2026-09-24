/**
 * The buddy-family static catalog row.
 *
 * CodeBuddy (intl + CN) and WorkBuddy describe their static fallback catalogs
 * with the same seven-field tuple and build each row the same way, differing
 * only in the wire endpoint the row targets. Both had their own copy of the
 * tuple type and the builder, so a new column meant editing two identical
 * declarations.
 *
 * Only the row shape and the builder are shared. Identity headers are not:
 * `codebuddyHeaders` and `workbuddyHeaders` send genuinely different bytes
 * (`X-Product`/`X-IDE-Type`/`X-Domain` versus `origin`/`referer` and the
 * account-derived `x-user-id`/`x-machine-id`/`x-session-id`), and those stay
 * with their own provider.
 */
import { GatewayError } from "../../../transport/gateway-error";
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

/** One static catalog row: id, display name, flags, limits, optional tool override. */
export type BuddyRawEntry = readonly [
  string,
  string,
  boolean,
  boolean,
  number | null,
  number | null,
  /** Explicit tool support. Omitted → derived from the base catalog. */
  boolean?,
];

/**
 * Builds one buddy catalog row.
 *
 * `endpoint` is explicit rather than left to the generic `/chat/completions`
 * default because the two families disagree about it: CodeBuddy's base URL
 * carries a version segment the default joins onto correctly, while
 * WorkBuddy's does not — the default would produce
 * `https://www.workbuddy.ai/chat/completions`, which that upstream answers
 * with a 405 HTML page. Callers pass the endpoint their base URL actually
 * serves, and `undefined` for the default.
 */
export function makeBuddyModel(
  entry: BuddyRawEntry,
  providerId: string,
  endpoint?: string,
): ModelDefinition {
  if (!entry[0]) throw new GatewayError("invalid_request", 400, "invalid model");
  return defineModel({
    id: entry[0],
    providerId,
    ...(endpoint === undefined ? {} : { endpoint }),
    reasoning: entry[2],
    vision: entry[3],
    ctx: entry[4],
    out: entry[5],
    ...(entry[6] === undefined ? {} : { toolCall: entry[6] }),
  });
}
