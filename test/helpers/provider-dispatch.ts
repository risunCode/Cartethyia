/**
 * Fixtures for provider-adapter dispatch tests: a recording transport, a
 * canonical request builder, and dispatch-target/context constructors.
 *
 * This lives under `test/` because nothing in `src/` imports it — it exists
 * only so adapter suites can exercise a real `adapter.dispatch()` without
 * hand-rolling a fetcher stub per provider.
 */
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import type {
  ProviderDispatchTarget,
  ProviderAdapter,
  ProviderDispatchContext,
  ResolvedCredential,
} from "../../src/providers/provider-registry";

/** One outbound request recorded by `captureRequest`. */
export interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

const CHAT_JSON: Record<string, unknown> = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
};
const RESPONSES_JSON: Record<string, unknown> = { id: "resp_1", status: "completed", output: [] };

/** Stub transport that records every outbound request and replies with `json`. */
export function captureRequest(json: Record<string, unknown> = CHAT_JSON): {
  fetch: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    requests.push({
      url,
      headers: Object.fromEntries(
        new Headers(init?.headers as HeadersInit) as unknown as Iterable<[string, string]>,
      ),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

export function canonicalRequest(
  options: {
    readonly stream?: boolean;
    readonly model?: string;
    readonly surface?: CanonicalRequest["source_surface"];
  } = {},
): CanonicalRequest {
  return {
    model: options.model ?? "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: options.stream ?? false,
    source_surface: options.surface ?? "chat",
  };
}

export function candidateFor(
  providerId: ProviderDispatchTarget["provider_id"],
  wireFamily: ProviderDispatchTarget["wire_family"],
  endpointPath: string,
  modelId = "test-model",
): ProviderDispatchTarget {
  return {
    provider_id: providerId,
    model_id: modelId,
    wire_family: wireFamily,
    endpoint_path: endpointPath,
    capabilities: {},
  };
}

export function dispatchContext(
  providerId: ProviderDispatchContext["credential"]["provider_id"],
  credential: Partial<ResolvedCredential> = {},
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: providerId,
      credential_kind: "api_key",
      secret: new TextEncoder().encode("test-secret-token"),
      ...credential,
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

/**
 * Builds the adapter through `create` with a recording transport, runs one
 * dispatch, and returns the single request it emitted.
 */
export async function dispatchJson(options: {
  readonly create: (fetchImpl: typeof fetch) => ProviderAdapter;
  readonly candidate: ProviderDispatchTarget;
  readonly request?: CanonicalRequest;
  readonly context?: ProviderDispatchContext;
  readonly json?: Record<string, unknown>;
}): Promise<CapturedRequest> {
  const { candidate } = options;
  const { fetch, requests } = captureRequest(
    options.json ?? (candidate.wire_family === "responses" ? RESPONSES_JSON : CHAT_JSON),
  );
  const adapter = options.create(fetch);
  const request = options.request ?? canonicalRequest();
  const context = options.context ?? dispatchContext(candidate.provider_id);
  for await (const _event of adapter.dispatch(request, candidate, context)) {
    // drain
  }
  const captured = requests[0];
  if (!captured) throw new Error(`${candidate.provider_id}: dispatch produced no outbound request`);
  return captured;
}
