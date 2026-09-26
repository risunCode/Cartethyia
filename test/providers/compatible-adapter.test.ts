import { describe, expect, test } from "bun:test";
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterConfig } from "../../src/providers/compatible-adapter";
import { GatewayError } from "../../src/transport/gateway-error";
import type { ProviderDispatchTarget, ProviderDispatchContext, ResolvedCredential } from "../../src/providers/provider-registry";
import type { CanonicalEvent, CanonicalRequest } from "../../src/transport/canonical-model";

function fakeCanonicalRequest(
  overrides: Partial<CanonicalRequest> & Record<string, unknown> = {},
): CanonicalRequest {
  const base: CanonicalRequest = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
  return { ...base, ...(overrides as Partial<CanonicalRequest>) } as CanonicalRequest;
}

function fakeProviderDispatchTarget(
  wireFamily: ProviderDispatchTarget["wire_family"] = "chat",
  endpointPath = "/v1/chat/completions",
): ProviderDispatchTarget {
  return {
    provider_id: "openai",
    model_id: "gpt-4o-mini",
    wire_family: wireFamily,
    endpoint_path: endpointPath,
    capabilities: {},
  };
}

function credential(secret = "secret"): ResolvedCredential {
  return {
    provider_id: "openai",
    credential_kind: "api_key",
    secret: new TextEncoder().encode(secret),
  };
}

function baseConfig(
  fetchFn: typeof fetch,
  overrides: Partial<OpenAICompatibleAdapterConfig> = {},
): OpenAICompatibleAdapterConfig {
  return {
    provider_id: "openai",
    base_url: "https://api.example.com",
    authentication_header_shape: "authorization_bearer",
    fetch: fetchFn,
    ...overrides,
  };
}

function dispatchContext(): ProviderDispatchContext {
  return {
    credential: credential(),
    deadline: Date.now() + 5000,
    abort_signal: new AbortController().signal,
  };
}



describe("OpenAICompatibleAdapter Responses response parsing", () => {
  test("parses a non-streaming Responses JSON body into non-empty canonical content", async () => {
    const adapter = new OpenAICompatibleAdapter(
      baseConfig(
        (async () =>
          new Response(
            JSON.stringify({
              id: "resp_1",
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "hello from responses" }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      ),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest({ source_surface: "responses" }),
      fakeProviderDispatchTarget("responses", "/v1/responses"),
      dispatchContext(),
    ))
      events.push(event);
    const text = events.find(
      (event) => event.type === "content_delta" && event.content.kind === "text",
    );
    expect(text).toBeDefined();
    expect(
      text?.type === "content_delta" && text.content.kind === "text" ? text.content.text : "",
    ).toBe("hello from responses");
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal?.type === "terminal" ? terminal.state : undefined).toBe("complete");
  });

  test("parses a streaming Responses SSE body into canonical text and tool-call deltas", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp_1","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]}}',
      'data: {"type":"response.output_text.delta","delta":"partial "}',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"call_1","call_id":"call_1","name":"lookup"}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"{\\"x\\":1}"}',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
      "data: [DONE]",
    ].join("\n\n");
    const adapter = new OpenAICompatibleAdapter(
      baseConfig(
        (async () =>
          new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })) as unknown as typeof fetch,
      ),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest({ source_surface: "responses", stream: true }),
      fakeProviderDispatchTarget("responses", "/v1/responses"),
      dispatchContext(),
    ))
      events.push(event);
    const text = events.find(
      (event) => event.type === "content_delta" && event.content.kind === "text",
    );
    expect(
      text?.type === "content_delta" && text.content.kind === "text" ? text.content.text : "",
    ).toBe("partial ");
    const toolDelta = events.find((event) => event.type === "tool_call_delta");
    expect(toolDelta?.type === "tool_call_delta" ? toolDelta.call_id : undefined).toBe("call_1");
    expect(toolDelta?.type === "tool_call_delta" ? toolDelta.arguments_delta : undefined).toBe(
      '{"x":1}',
    );
    // Lifecycle frames (response.created here) are bookkeeping the translator
    // already summarizes via response_start/terminal. They MUST NOT surface as
    // canonical content of any kind — otherwise oversized payloads such as the
    // full tool schema would blow past the Anthropic SSE line bound downstream.
    expect(
      events.some(
        (event) =>
          event.type === "content_delta" &&
          event.content.kind === "extension" &&
          typeof event.content.name === "string" &&
          event.content.name.startsWith("responses:response."),
      ),
    ).toBe(false);
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal?.type === "terminal" ? terminal.state : undefined).toBe("complete");
  });
});

describe("OpenAICompatibleAdapter stop-reason mapping", () => {
  test("maps Chat finish_reason to canonical stop reasons", async () => {
    for (const [finishReason, expected] of [
      ["stop", "stop"],
      ["length", "length"],
      ["tool_calls", "tool_use"],
      ["content_filter", "content_filter"],
    ] as const) {
      const adapter = new OpenAICompatibleAdapter(
        baseConfig(
          (async () =>
            new Response(
              JSON.stringify({
                choices: [{ message: { content: "ok" }, finish_reason: finishReason }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )) as unknown as typeof fetch,
        ),
      );
      const events = [];
      for await (const event of adapter.dispatch(
        fakeCanonicalRequest(),
        fakeProviderDispatchTarget(),
        dispatchContext(),
      ))
        events.push(event);
      const terminal = events.find((event) => event.type === "terminal");
      expect(terminal?.type === "terminal" ? terminal.stop_reason : undefined).toBe(expected);
      expect(terminal?.type === "terminal" ? terminal.provider_stop_reason : undefined).toBe(
        finishReason,
      );
    }
  });

  test("maps Responses status to canonical stop reasons", async () => {
    for (const [status, expected] of [
      ["completed", "stop"],
      ["incomplete", "length"],
      ["failed", "error"],
      ["cancelled", "error"],
    ] as const) {
      const adapter = new OpenAICompatibleAdapter(
        baseConfig(
          (async () =>
            new Response(JSON.stringify({ status, output: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })) as unknown as typeof fetch,
        ),
      );
      const events = [];
      for await (const event of adapter.dispatch(
        fakeCanonicalRequest({ source_surface: "responses" }),
        fakeProviderDispatchTarget("responses", "/v1/responses"),
        dispatchContext(),
      ))
        events.push(event);
      const terminal = events.find((event) => event.type === "terminal");
      expect(terminal?.type === "terminal" ? terminal.stop_reason : undefined).toBe(expected);
      expect(terminal?.type === "terminal" ? terminal.provider_stop_reason : undefined).toBe(
        status,
      );
    }
  });
});

describe("OpenAICompatibleAdapter prompt-cache emission", () => {
  test("sends no cache directive on the Chat payload: OpenAI caching is server-automatic", async () => {
    let capturedBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(
      baseConfig((async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest({ cache_hint: "stable_prefix" }),
      fakeProviderDispatchTarget(),
      dispatchContext(),
    ))
      events.push(event);
    // The caller's cache key still travels when explicitly supplied (see
    // the extension passthrough), but no top-level directive is synthesized:
    // OpenAI applies prefix caching server-side with no request fields.
    expect(capturedBody["prompt_cache_options"]).toBeUndefined();
    expect(capturedBody["prompt_cache_key"]).toBeUndefined();
  });

  test("sends no cache directive on the Responses payload: OpenAI caching is server-automatic", async () => {
    let capturedBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(
      baseConfig((async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ status: "completed", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest({ source_surface: "responses", cache_hint: "stable_prefix" }),
      fakeProviderDispatchTarget("responses", "/v1/responses"),
      dispatchContext(),
    ))
      events.push(event);
    expect(capturedBody["prompt_cache_options"]).toBeUndefined();
    expect(capturedBody["prompt_cache_key"]).toBeUndefined();
  });
});

describe("OpenAICompatibleAdapter generation-control wire filtering", () => {
  test("forwards Chat-supported generation controls but drops unsupported top_k", async () => {
    let capturedBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(
      baseConfig((async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest({
        generation_controls: { temperature: 0.5, top_k: 40 } as CanonicalRequest["generation_controls"],
      }),
      fakeProviderDispatchTarget(),
      dispatchContext(),
    ))
      events.push(event);
    expect(capturedBody["temperature"]).toBe(0.5);
    expect(capturedBody["top_k"]).toBeUndefined();
  });

  test("forwards generation controls on the Responses payload instead of dropping them silently", async () => {
    let capturedBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(
      baseConfig((async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ status: "completed", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest({
        source_surface: "responses",
        generation_controls: {
          temperature: 0.7,
          max_tokens: 512,
          top_k: 40,
        } as CanonicalRequest["generation_controls"],
      }),
      fakeProviderDispatchTarget("responses", "/v1/responses"),
      dispatchContext(),
    ))
      events.push(event);
    expect(capturedBody["temperature"]).toBe(0.7);
    // max_tokens coalesces into max_output_tokens for the Responses wire; top_k has no Responses equivalent.
    expect(capturedBody["max_output_tokens"]).toBe(512);
    expect(capturedBody["top_k"]).toBeUndefined();
    expect(capturedBody["max_tokens"]).toBeUndefined();
  });
});

describe("OpenAICompatibleAdapter usage normalization", () => {
  test("normalizes cached and reasoning token usage details", async () => {
    const adapter = new OpenAICompatibleAdapter(
      baseConfig(
        (async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 8,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      ),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest(),
      fakeProviderDispatchTarget(),
      dispatchContext(),
    ))
      events.push(event);
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal?.type === "terminal" ? terminal.usage?.cached_input_tokens : undefined).toBe(4);
    expect(terminal?.type === "terminal" ? terminal.usage?.reasoning_tokens : undefined).toBe(3);
  });
});

describe("OpenAICompatibleAdapter Responses system/instructions", () => {
  test("serializes top-level system and instructions as leading input items", async () => {
    let capturedBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(
      baseConfig((async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ status: "completed", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch),
    );
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest({
        source_surface: "responses",
        system: [{ kind: "text", text: "be concise" }],
        instructions: [{ kind: "text", text: "follow house style" }],
      }),
      fakeProviderDispatchTarget("responses", "/v1/responses"),
      dispatchContext(),
    ))
      events.push(event);
    const input = capturedBody["input"] as Array<Record<string, unknown>>;
    expect(Array.isArray(input)).toBe(true);
    expect(input.some((item) => item["role"] === "system")).toBe(true);
    expect(input.some((item) => item["role"] === "developer")).toBe(true);
  });
});

describe("OpenAICompatibleAdapter credential_forwarding", () => {
  test("withholds Authorization when credential_forwarding is 'never', even with a configured api_key secret", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const adapter = new OpenAICompatibleAdapter(
      baseConfig(
        (async (_url: string, init?: RequestInit) => {
          seenHeaders.push({ ...(init?.headers as Record<string, string> | undefined) });
          return new Response(
            JSON.stringify({ id: "resp_1", object: "chat.completion", choices: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
        { credential_forwarding: "never" },
      ),
    );
    for await (const _event of adapter.dispatch(
      fakeCanonicalRequest(),
      fakeProviderDispatchTarget(),
      dispatchContext(),
    ));
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]?.authorization).toBeUndefined();
  });

  test("forwards Authorization by default when the account declares an api_key secret", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const adapter = new OpenAICompatibleAdapter(
      baseConfig((async (_url: string, init?: RequestInit) => {
        seenHeaders.push({ ...(init?.headers as Record<string, string> | undefined) });
        return new Response(
          JSON.stringify({ id: "resp_1", object: "chat.completion", choices: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch),
    );
    for await (const _event of adapter.dispatch(
      fakeCanonicalRequest(),
      fakeProviderDispatchTarget(),
      dispatchContext(),
    ));
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]?.authorization).toBe("Bearer secret");
  });
});

// T0-4: Verify the fix for invalid structured_output json_schema envelope
// The fix is implemented in compatible-adapter.ts:244-262 which defaults to json_object
// when json_schema mode has no real schema, avoiding invalid strict:true with empty schema

function streamingCredential(): ResolvedCredential {
  return {
    provider_id: "openai",
    credential_kind: "api_key",
    secret: new TextEncoder().encode("secret"),
  };
}

function fakeStreamingRequest(): CanonicalRequest {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: [{ kind: "text", text: "count" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "responses",
  };
}

function fakeStreamingProviderDispatchTarget(): ProviderDispatchTarget {
  return {
    provider_id: "openai",
    model_id: "gpt-4o-mini",
    wire_family: "responses",
    endpoint_path: "/v1/responses",
    capabilities: {},
  };
}

function streamingDispatchContext(): ProviderDispatchContext {
  return {
    credential: streamingCredential(),
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

/**
 * A "gate" is a promise + explicit resolve — the producer waits on the gate,
 * the consumer resolves it after observing the previous chunk's canonical
 * event. This creates a strict happens-before edge between "consumer saw
 * event N" and "producer emits chunk N+1", provable without any timers.
 */
function makeGate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("streaming e2e — incremental delivery of upstream chunks", () => {
  test("adapter emits each content_delta before the next upstream chunk is enqueued", async () => {
    const gates = [makeGate(), makeGate(), makeGate(), makeGate()];
    const chunks = [
      'data: {"type":"response.output_text.delta","delta":"tok-1 "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"tok-2 "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"tok-3"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":7}}}\n\ndata: [DONE]\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) await gates[i - 1]!.wait;
          controller.enqueue(enc.encode(chunks[i]!));
        }
        await gates[3]!.wait;
        controller.close();
      },
    });

    const fakeFetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const adapter = new OpenAICompatibleAdapter({
      provider_id: "openai",
      base_url: "https://api.example.com",
      authentication_header_shape: "authorization_bearer",
      fetch: fakeFetch,
    });

    const deltas: string[] = [];
    let terminalUsage: unknown;
    let sawTerminal = false;
    let deltaIndex = 0;
    for await (const event of adapter.dispatch(fakeStreamingRequest(), fakeStreamingProviderDispatchTarget(), streamingDispatchContext())) {
      const typed = event as CanonicalEvent;
      if (typed.type === "content_delta" && typed.content.kind === "text") {
        deltas.push(typed.content.text);
        gates[deltaIndex]!.open();
        deltaIndex += 1;
      } else if (typed.type === "terminal") {
        sawTerminal = true;
        terminalUsage = typed.usage;
        gates[3]!.open();
      }
    }

    expect(deltas).toEqual(["tok-1 ", "tok-2 ", "tok-3"]);
    expect(sawTerminal).toBe(true);
    expect(terminalUsage).toMatchObject({ input_tokens: 3, output_tokens: 7 });
  });

  test("a non-SSE, non-JSON body raises a typed upstream error, not a bare SyntaxError", async () => {
    // A streaming request answered with a plain-text/garbage body used to hit
    // `res.json()` and throw an untyped `SyntaxError`, which no classifier
    // recognizes: telemetry recorded `unknown_error` and the client saw a 500
    // "the upstream failure could not be classified". It must instead be a
    // typed 502 that carries what the upstream actually said.
    const fakeFetch = (async () =>
      new Response("upstream is having a bad day", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleAdapter(
      baseConfig(fakeFetch),
    );
    const request = { ...fakeCanonicalRequest(), stream: true } as CanonicalRequest;
    let caught: unknown;
    try {
      for await (const _event of adapter.dispatch(
        request,
        fakeProviderDispatchTarget("chat"),
        dispatchContext(),
      )) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    const gateway = caught as GatewayError;
    expect(gateway.code).toBe("transport_unavailable");
    expect(gateway.status).toBe(502);
    expect(gateway.origin).toBe("upstream");
    expect(gateway.message).toContain("non-JSON response");
  });

  test("a JSON error envelope on a 2xx surfaces the provider code, not an empty success", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { code: "11148", message: "tool_call_sequence_broken" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleAdapter(
      baseConfig(fakeFetch),
    );
    let caught: unknown;
    try {
      for await (const _event of adapter.dispatch(
        fakeCanonicalRequest(),
        fakeProviderDispatchTarget("chat"),
        dispatchContext(),
      )) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    const gateway = caught as GatewayError;
    expect(gateway.code).toBe("transport_unavailable");
    expect(gateway.origin).toBe("upstream");
    expect(gateway.details.providerCode).toBe("11148");
    expect(gateway.message).toContain("tool_call_sequence_broken");
  });
});