/**
 * Qwen Portal answers a 500 when a request carries more than one system
 * message — its default chat template concatenates them and rejects the
 * result. The gateway emits one system block per canonical part, so a request
 * that opens with a persona plus project instructions produces two blocks and
 * is refused.
 *
 * The fix has to run *before* serialization: `canonicalToChatPayload` is what
 * splits `request.system` into blocks, so coalescing the outgoing payload would
 * be operating downstream of the thing being fixed. These drive the real
 * dispatch and inspect the posted body.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const registry = createDefaultProviderRegistry();

const TARGET = {
  provider_id: "qwen-portal",
  model_id: "coder-model",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function request(system: CanonicalRequest["system"]): CanonicalRequest {
  return {
    model: "coder-model",
    system,
    messages: [
      { role: "user", content: [{ kind: "text", text: "hi" }] },
    ],
    generation_controls: {},
  } as unknown as CanonicalRequest;
}

async function postBody(system: CanonicalRequest["system"]): Promise<Captured> {
  const adapter = await registry.resolve("qwen-portal");
  expect(adapter).toBeDefined();
  let captured: Captured | undefined;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    const body = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;

  const stream = adapter!.dispatch(request(system), TARGET, {
    credential: {
      provider_id: "qwen-portal",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("sk-qwen"),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher as never,
  } as unknown as ProviderDispatchContext);
  for await (const _event of stream) void _event;
  expect(captured).toBeDefined();
  return captured!;
}

describe("qwen-portal system message coalescing", () => {
  test("posts one system block for two system parts", async () => {
    const captured = await postBody([
      { kind: "text", text: "You are a helpful assistant." },
      { kind: "text", text: "Answer in French." },
    ]);
    const messages = captured.body["messages"] as { role: string; content: unknown }[];
    const systemBlocks = messages.filter((m) => m.role === "system");
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0]?.content).toBe(
      "You are a helpful assistant.\n\nAnswer in French.",
    );
  });

  test("leaves a single system part untouched", async () => {
    const captured = await postBody([{ kind: "text", text: "Only one." }]);
    const messages = captured.body["messages"] as { role: string; content: unknown }[];
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(messages.find((m) => m.role === "system")?.content).toBe("Only one.");
  });

  test("keeps the non-system turns in order", async () => {
    // Coalescing must not reorder or swallow the conversation itself.
    const captured = await postBody([
      { kind: "text", text: "A" },
      { kind: "text", text: "B" },
    ]);
    const messages = captured.body["messages"] as { role: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages.some((m) => m.role === "user")).toBe(true);
  });

  test("dispatches to the portal chat endpoint", async () => {
    const captured = await postBody([{ kind: "text", text: "A" }]);
    expect(captured.url).toBe("https://portal.qwen.ai/v1/chat/completions");
  });
});