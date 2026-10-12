/**
 * Factory Droid adapter.
 *
 * Factory's LLM proxy multiplexes several wire protocols behind one WorkOS
 * bearer, and the path prefix differs per protocol, so a single declarative
 * `ApiKeyProviderSpec` cannot describe it:
 *
 * | wire family | path |
 * |---|---|
 * | `chat` | `/api/llm/o/v1/chat/completions` |
 * | `responses` | `/api/llm/o/v1/responses` |
 * | `messages` | `/api/llm/a/v1/messages` |
 *
 * Three more things sit outside the shared factory:
 *
 * 1. **The credential is an envelope.** The console stores one opaque string,
 *    and this provider's secret is `{ accessToken, orgId }` — the org id comes
 *    from the token's `external_org_id` claim and is required as
 *    `X-Factory-Org-Id`, because Factory scopes every call to the approving
 *    user's organization.
 * 2. **The host is per-account.** Residency is resolved at login
 *    (`/api/cli/whoami`) and recorded in account `auth_state`; EU accounts are
 *    served from `api.eu.factory.ai` and everything else from `api.factory.ai`.
 *    Dispatching an EU credential to the global host is a 404 that names
 *    neither cause, so the host is resolved from stored state at transport time.
 * 3. **Client identity is required.** Factory's own headers (`X-Factory-Client`,
 *    `X-Client-Version`) identify a first-party client; the request is refused
 *    without them.
 */
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../contracts";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "../shared/claude-messages";
import { sendClaudeMessagesRequest } from "../../../protocol/upstream/send-claude-messages";
import { applyParamQuirks } from "../../../transport/translation/quirks";
import { createApiKeyAdapter } from "../shared/configured-provider";
import type { ApiKeyProviderSpec } from "../shared/configured-provider";
import { decodeFactoryDroidCredential } from "../../../security/credential-codec";

export const FACTORY_DROID_PROVIDER_ID = "factory-droid" as const;

/** Default host; an EU account resolves to {@link FACTORY_DROID_EU_BASE_URL} instead. */
export const FACTORY_DROID_BASE_URL = "https://api.factory.ai";
export const FACTORY_DROID_EU_BASE_URL = "https://api.eu.factory.ai";

/**
 * Path prefixes Factory multiplexes per wire protocol, relative to the host.
 *
 * These go in the endpoint path, not the base URL: `ProviderDispatchTarget`
 * carries the endpoint path from the model row, and `joinUrl` concatenates
 * both verbatim, so a prefix present in each would dispatch to
 * `…/api/llm/a/api/llm/a/v1/messages`.
 */
const OPENAI_WIRE_BASE = "/api/llm/o/v1";

/**
 * Client identity Factory expects on every call.
 *
 * Pinned to the version Factory's own CLI reports. A version the proxy does not
 * recognise is still a first-party-shaped request; inventing a new number per
 * release would claim compatibility this build has not tested.
 */
const FACTORY_DROID_CLIENT_VERSION = "1.0.0";

function factoryDroidClientHeaders(orgId: string): Record<string, string> {
  return {
    "X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
    "X-Factory-Client": "cli",
    "X-Factory-Org-Id": orgId,
    "user-agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
  };
}

/**
 * The API host for this account.
 *
 * Residency is read from account `auth_state`, where the login recorded what
 * `/api/cli/whoami` reported. An account with no recorded residency is the
 * global host, which is Factory's default.
 */
export function factoryDroidBaseUrl(context: ProviderDispatchContext): string {
  const region = context.credential.auth_state?.["region"];
  return region === "eu" ? FACTORY_DROID_EU_BASE_URL : FACTORY_DROID_BASE_URL;
}

/**
 * Decodes the stored envelope, failing closed.
 *
 * Unlike a bare bearer there is no meaningful partial state here: without the
 * org claim Factory rejects the call as an unscoped identity, so a credential
 * that does not decode is an error the operator has to fix by signing in again,
 * not a request worth attempting against the default host.
 */
function factoryDroidEnvelope(context: ProviderDispatchContext): { token: string; orgId: string } {
  const secret = context.credential.secret;
  if (secret === undefined || secret.length === 0) {
    throw new GatewayError("invalid_request", 400, "factory-droid: credential is missing a secret value");
  }
  try {
    const envelope = decodeFactoryDroidCredential(secret);
    return { token: envelope.accessToken, orgId: envelope.orgId };
  } catch (error) {
    throw new GatewayError(
      "invalid_request",
      400,
      `factory-droid: ${error instanceof Error ? error.message : "stored credential is not a Factory Droid envelope"}`,
    );
  }
}

/** Shared spec for the two OpenAI-family legs, with the envelope applied. */
function openAiWireSpec(context: ProviderDispatchContext): ApiKeyProviderSpec {
  const { token, orgId } = factoryDroidEnvelope(context);
  return {
    provider_id: FACTORY_DROID_PROVIDER_ID,
    endpoint_paths_by_wire_family: {
      chat: `${OPENAI_WIRE_BASE}/chat/completions`,
      responses: `${OPENAI_WIRE_BASE}/responses`,
    },
    resolveBaseUrl: () => factoryDroidBaseUrl(context),
    extra_headers: { ...factoryDroidClientHeaders(orgId), authorization: `Bearer ${token}` },
  };
}

/**
 * Factory Droid dispatch: the OpenAI-shaped legs for chat/responses, and the
 * native Messages leg for `messages`.
 *
 * The Messages leg is built directly rather than through the shared factory
 * because Factory authenticates it with the same bearer but stamps its own
 * client identity headers, and `buildClaudeMessagesRequest` is where those
 * headers are assembled.
 */
class FactoryDroidAdapter implements ProviderAdapter {
  readonly provider_id = FACTORY_DROID_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const { token, orgId } = factoryDroidEnvelope(context);
    const baseUrl = factoryDroidBaseUrl(context);

    if (candidate.wire_family === "messages") {
      const outbound = buildClaudeMessagesRequest({
        request: applyParamQuirks(request, candidate.provider_id),
        authHeader: "bearer",
        credential: {
          secret: token,
          customHeaders: {
            ...factoryDroidClientHeaders(orgId),
            ...filterClaudeCustomHeaders({ ...context.credential.custom_headers }),
          },
        },
        baseUrl,
        endpointPath: candidate.endpoint_path,
      });
      yield* sendClaudeMessagesRequest(
        outbound.url,
        outbound.headers,
        outbound.body,
        context,
        request,
        this.fetchFn,
      );
      return;
    }

    // The OpenAI-shaped legs are built per dispatch: the bearer and the org id
    // are read from the credential then, not captured when the registry
    // resolved this adapter. One spec carries both paths.
    yield* createApiKeyAdapter(openAiWireSpec(context), this.fetchFn).dispatch(
      request,
      candidate,
      context,
    );
  }
}

export function createFactoryDroidAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new FactoryDroidAdapter(fetchImpl);
}

export const factoryDroidAdapter: ProviderAdapter = new FactoryDroidAdapter();