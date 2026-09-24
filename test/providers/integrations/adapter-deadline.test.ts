import { describe, expect, test } from "bun:test";
import { createAgentRouterAdapter } from "../../../src/providers/integrations/agentrouter";
import { createGeminiAdapter } from "../../../src/providers/integrations/gemini";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../src/providers/provider-registry";

const encoder = new TextEncoder();

/**
 * Emits one SSE frame immediately, then one every `gapMs`. The pre-stream
 * phase ends as soon as headers arrive; the body outlives a short adapter
 * deadline on purpose.
 */
function slowSseFetch(frames: readonly string[], gapMs: number): typeof fetch {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        while (index < frames.length) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
          controller.enqueue(encoder.encode(`data: ${frames[index]}\n\n`));
          index++;
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

function messagesRequest(): CanonicalRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "messages",
  } as CanonicalRequest;
}

function chatRequest(): CanonicalRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  } as CanonicalRequest;
}

function context(providerId: string, deadlineInMs: number): ProviderDispatchContext {
  return {
    credential: {
      provider_id: providerId,
      credential_kind: "api_key",
      secret: encoder.encode("key"),
    },
    deadline: Date.now() + deadlineInMs,
    abort_signal: new AbortController().signal,
  } as ProviderDispatchContext;
}

async function terminalState(events: AsyncIterable<unknown>): Promise<unknown> {
  let terminal: unknown;
  for await (const event of events) terminal = event;
  return (terminal as { type?: string; state?: string }).state;
}

/**
 * Never returns headers, and rejects with the signal's own abort reason.
 *
 * That is what the platform does for `abort(reason)`: the reason reaches the
 * caller as-is, so a deadline abort arrives as a plain `Error` whose `name` is
 * `"Error"`, not an `AbortError`. A predicate that only checks `err.name` would
 * let it escape unmapped; the adapter must still answer 499.
 */
function stallingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) void _event;
}

describe("adapter pre-stream deadline must not kill healthy streams", () => {
  test("agentrouter survives past an expired pre-stream deadline", async () => {
    const adapter = createAgentRouterAdapter({
      fetch: slowSseFetch(
        [
          JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
          JSON.stringify({ type: "message_stop" }),
        ],
        80,
      ),
    });
    const candidate = {
      provider_id: "agentrouter",
      model_id: "test-model",
      wire_family: "messages",
      endpoint_path: "/v1/messages",
      capabilities: {},
    } as ProviderDispatchTarget;
    // Expires ~30ms in: headers arrive immediately, body takes ~160ms.
    const state = await terminalState(adapter.dispatch(messagesRequest(), candidate, context("agentrouter", 30)));
    expect(state).toBe("complete");
  }, 10_000);

  test("gemini survives past an expired pre-stream deadline", async () => {
    const adapter = createGeminiAdapter({
      fetch: slowSseFetch(
        [
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "hel" }] } }] }),
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
          }),
        ],
        80,
      ),
    });
    const candidate = {
      provider_id: "gemini",
      model_id: "gemini-2.0-flash",
      wire_family: "chat",
      endpoint_path: "/v1beta/models",
      capabilities: {},
    } as unknown as ProviderDispatchTarget;
    const state = await terminalState(adapter.dispatch(chatRequest(), candidate, context("gemini", 30)));
    expect(state).toBe("complete");
  }, 10_000);

  test("agentrouter maps a pre-stream deadline to transport_closed 499", async () => {
    const adapter = createAgentRouterAdapter({ fetch: stallingFetch() });
    const candidate = {
      provider_id: "agentrouter",
      model_id: "test-model",
      wire_family: "messages",
      endpoint_path: "/v1/messages",
      capabilities: {},
    } as ProviderDispatchTarget;
    await expect(
      drain(adapter.dispatch(messagesRequest(), candidate, context("agentrouter", 10))),
    ).rejects.toMatchObject({ code: "transport_closed", status: 499 });
  }, 10_000);

  test("gemini maps a pre-stream deadline to transport_closed 499", async () => {
    const adapter = createGeminiAdapter({ fetch: stallingFetch() });
    const candidate = {
      provider_id: "gemini",
      model_id: "gemini-2.0-flash",
      wire_family: "chat",
      endpoint_path: "/v1beta/models",
      capabilities: {},
    } as unknown as ProviderDispatchTarget;
    await expect(
      drain(adapter.dispatch(chatRequest(), candidate, context("gemini", 10))),
    ).rejects.toMatchObject({ code: "transport_closed", status: 499 });
  }, 10_000);
});
