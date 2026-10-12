/**
 * Alibaba Token Plan (Coding Plan) adapter.
 *
 * OpenAI chat-completions on an OpenAI-compatible path, so the shared factory
 * does the translation. One thing sits outside its declarative spec: the two
 * plans are served by different hosts and their keys are not interchangeable,
 * and which plan a key belongs to is per-account state stored with it. A spec
 * declares one `base_url` at construction, so the host is resolved from the
 * credential at dispatch time and a stored region that no longer resolves is a
 * dispatch-time error rather than a silent fallback to the default host.
 */
import { createApiKeyAdapter } from "../shared/configured-provider";
import type { ApiKeyProviderSpec } from "../shared/configured-provider";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../contracts";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { decodeAlibabaCodingPlanCredential } from "../../../security/credential-codec";
import type { AlibabaCodingPlanEnvelope } from "../../../security/credential-codec";
import { alibabaCodingPlanBaseUrl } from "./alibaba-coding-plan-oauth";

export const ALIBABA_CODING_PLAN_PROVIDER_ID = "alibaba-coding-plan" as const;

/**
 * Builds the per-dispatch spec from one decoded envelope.
 *
 * `endpoint_paths_by_wire_family` is unprefixed because the resolved base URL
 * already ends in `/compatible-mode/v1` — `joinUrl` concatenates verbatim, so a
 * `/v1`-prefixed path here would dispatch to `…/compatible-mode/v1/v1/…`.
 */
function alibabaSpec(envelope: AlibabaCodingPlanEnvelope): ApiKeyProviderSpec {
  const baseUrl = alibabaCodingPlanBaseUrl(envelope.region);
  if (baseUrl === undefined) {
    // Already checked by `alibabaEnvelope`; this narrows the type rather than
    // re-deciding the outcome.
    throw new GatewayError(
      "invalid_request",
      400,
      `alibaba-coding-plan: stored region "${envelope.region}" is not a known plan; sign in again`,
    );
  }
  return {
    provider_id: ALIBABA_CODING_PLAN_PROVIDER_ID,
    endpoint_paths_by_wire_family: { chat: "/chat/completions", responses: "/responses" },
    resolveBaseUrl: () => baseUrl,
    // The factory forwards the stored secret verbatim as the bearer, and the
    // stored secret is the envelope, so the token inside it is stamped here.
    extra_headers: { authorization: `Bearer ${envelope.token}` },
  };
}

/**
 * Decoded plan credential, or a dispatch-time error naming what is missing.
 *
 * The region is checked here so an unknown plan fails with a name rather than a
 * URL built from nothing.
 */
function alibabaEnvelope(context: ProviderDispatchContext): AlibabaCodingPlanEnvelope {
  const secret = context.credential.secret;
  if (secret === undefined || secret.length === 0) {
    throw new GatewayError("invalid_request", 400, "alibaba-coding-plan: credential is missing a secret value");
  }
  let envelope: AlibabaCodingPlanEnvelope;
  try {
    envelope = decodeAlibabaCodingPlanCredential(secret);
  } catch (error) {
    throw new GatewayError(
      "invalid_request",
      400,
      `alibaba-coding-plan: ${error instanceof Error ? error.message : "stored credential is not an Alibaba envelope"}`,
    );
  }
  return envelope;
}

/**
 * Alibaba Token Plan dispatch.
 *
 * The adapter is built per dispatch because both the origin and the bearer come
 * from the stored envelope; a spec declared once at construction would capture
 * whichever account loaded the module first.
 */
class AlibabaCodingPlanAdapter implements ProviderAdapter {
  readonly provider_id = ALIBABA_CODING_PLAN_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const envelope = alibabaEnvelope(context);
    yield* createApiKeyAdapter(alibabaSpec(envelope), this.fetchFn).dispatch(
      request,
      candidate,
      context,
    );
  }
}

export function createAlibabaCodingPlanAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new AlibabaCodingPlanAdapter(fetchImpl);
}

export const alibabaCodingPlanAdapter: ProviderAdapter = new AlibabaCodingPlanAdapter();