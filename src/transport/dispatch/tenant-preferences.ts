/**
 * Tenant-preference request shaping applied after route preparation.
 *
 * Preferences are per-tenant runtime settings (`console_settings.preferences`)
 * that reshape a canonical request before dispatch: thinking normalization and
 * the Responses reasoning-summary override. Shaping failure is deliberately
 * non-fatal — a settings read outage must not fail an otherwise dispatchable
 * request.
 */
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { CanonicalRequest } from "../canonical-model";
import type { PreparedProxyRequest } from "../request/preparer";
import { normalizeThinkingConfig } from "../translation/thinking";
import { preferencesReaderFor } from "./attempt-finalize";

/**
 * Applies request shaping owned by tenant preferences and deployment config:
 * thinking normalization and the Responses reasoning summary override.
 * Failure is non-fatal.
 */
export async function applyTenantPreferences(
  prepared: PreparedProxyRequest,
  db: CartethyiaDatabase,
): Promise<CanonicalRequest> {
  let canonicalRequest = prepared.canonicalRequest;
  const tenantId = prepared.authorization.snapshot.tenant_id;
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    if (prefs?.thinkingNormalizationEnabled) {
      const next = normalizeThinkingConfig(canonicalRequest);
      if (next !== canonicalRequest) canonicalRequest = next;
    }
    if (prefs) {
      // When the routed model is Responses (codex/openai/muse-spark) and the
      // client hit a Chat surface, force the configured summary mode so the
      // Responses wire actually emits a reasoning summary. Default is
      // `detailed` (not encrypted/concise). This runs even when the inbound
      // request carried no `reasoning` block at all.
      const globalSummary = prefs.responsesReasoningSummary;
      const hasResponsesRouteCandidate = prepared.eligibleRouteCandidates.some(
        (c: { wire_family: string }) => c.wire_family === "responses",
      );
      if (globalSummary !== undefined && hasResponsesRouteCandidate) {
        const currentMode = canonicalRequest.reasoning?.summary_mode;
        if (currentMode !== globalSummary) {
          canonicalRequest = {
            ...canonicalRequest,
            reasoning: {
              ...(canonicalRequest.reasoning ?? {}),
              summary_mode: globalSummary,
            },
          };
        }
      }
    }
  } catch {
    // Non-fatal
  }
  return canonicalRequest;
}
