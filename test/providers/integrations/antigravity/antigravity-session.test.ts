import { describe, expect, test } from "bun:test";
import {
  AntigravityAdapter,
  antigravityThinkingBudget,
  signedAntigravitySessionId,
} from "../../../../src/providers/integrations/antigravity/antigravity";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../../src/providers/provider-registry";

const encoder = new TextEncoder();

const RESPONSE_BODY = {
  candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
  responseId: "resp-execution-1",
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
};

function mockFetch(captured: Record<string, unknown>[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (typeof init?.body === "string" && url.includes(":generateContent")) {
      captured.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    // Project lookup and version discovery share the mock: answer with an
    // empty project body (best-effort path tolerates the miss).
    if (!url.includes(":generateContent")) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(RESPONSE_BODY), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    conversation: { conversation_id: "conv-1" },
    ...overrides,
  } as CanonicalRequest;
}

function candidate(): ProviderDispatchTarget {
  return {
    provider_id: "antigravity",
    model_id: "claude-sonnet-4-5",
    wire_family: "chat",
    endpoint_path: "/v1internal:generateContent",
    capabilities: {},
  } as ProviderDispatchTarget;
}

function context(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "antigravity",
      credential_kind: "oauth",
      secret: encoder.encode("token"),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  } as ProviderDispatchContext;
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function envelopeOf(captured: Record<string, unknown>[]): Record<string, unknown> {
  return captured.at(-1) as Record<string, unknown>;
}

function requestOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload["request"] as Record<string, unknown>;
}

describe("antigravity session stickiness", () => {
  test("consecutive turns share ids and increment the step", async () => {
    const captured: Record<string, unknown>[] = [];
    const adapter = new AntigravityAdapter({ fetch: mockFetch(captured) });
    await collect(adapter.dispatch(request(), candidate(), context()));
    await collect(adapter.dispatch(request(), candidate(), context()));
    expect(captured).toHaveLength(2);
    const first = envelopeOf(captured.slice(0, 1));
    const second = envelopeOf(captured.slice(1));
    const firstRequest = requestOf(first);
    const secondRequest = requestOf(second);
    expect(secondRequest["sessionId"]).toBe(firstRequest["sessionId"]);
    expect(second["requestId"]).not.toBe(first["requestId"]);
    // agent/{agentId}/{ts}/{trajectoryId}/{step}: step 2 then 3.
    expect(String(second["requestId"]).endsWith("/3")).toBe(true);
    expect(String(first["requestId"]).endsWith("/2")).toBe(true);
    const firstLabels = firstRequest["labels"] as Record<string, string>;
    const secondLabels = secondRequest["labels"] as Record<string, string>;
    expect(secondLabels["trajectory_id"]).toBe(firstLabels["trajectory_id"]);
    expect(firstLabels["last_step_index"]).toBe("1");
    expect(secondLabels["last_step_index"]).toBe("2");
    // Second turn echoes the first turn's execution id.
    expect(secondLabels["last_execution_id"]).toBe("resp-execution-1");
    expect(firstLabels["last_execution_id"]).toBeUndefined();
  });

  test("different conversations get different sessions", async () => {
    const captured: Record<string, unknown>[] = [];
    const adapter = new AntigravityAdapter({ fetch: mockFetch(captured) });
    await collect(
      adapter.dispatch(request({ conversation: { conversation_id: "conv-a" } }), candidate(), context()),
    );
    await collect(
      adapter.dispatch(request({ conversation: { conversation_id: "conv-b" } }), candidate(), context()),
    );
    const ids = captured.map((payload) => requestOf(payload)["sessionId"]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("session id is a negative signed decimal (captured shape)", async () => {
    const captured: Record<string, unknown>[] = [];
    const adapter = new AntigravityAdapter({ fetch: mockFetch(captured) });
    await collect(adapter.dispatch(request(), candidate(), context()));
    expect(String(requestOf(envelopeOf(captured))["sessionId"])).toMatch(/^-\d+$/);
  });

  test("claude models get thinking budget, VALIDATED tool config, and identity", async () => {
    const captured: Record<string, unknown>[] = [];
    const adapter = new AntigravityAdapter({ fetch: mockFetch(captured) });
    await collect(adapter.dispatch(request(), candidate(), context()));
    const req = requestOf(envelopeOf(captured));
    const generationConfig = req["generationConfig"] as Record<string, unknown>;
    expect(generationConfig["thinkingConfig"]).toEqual({ includeThoughts: true, thinkingBudget: 10_000 });
    expect(req["toolConfig"]).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    // Identity rides the dedicated systemInstruction field, never a fake
    // user turn in contents.
    const systemInstruction = req["systemInstruction"] as Record<string, unknown>;
    const instructionParts = systemInstruction["parts"] as Array<Record<string, unknown>>;
    expect(String(instructionParts[0]?.["text"] ?? "").startsWith("You are Antigravity")).toBe(true);
    const contents = req["contents"] as Array<Record<string, unknown>>;
    const hasFakeUserTurn = contents.some(
      (content) =>
        content["role"] === "user" &&
        Array.isArray(content["parts"]) &&
        (content["parts"] as Array<Record<string, unknown>>).some(
          (part) => typeof part["text"] === "string" && (part["text"] as string).startsWith("You are Antigravity"),
        ),
    );
    expect(hasFakeUserTurn).toBe(false);
  });

  test("web_search tool injects googleSearch", async () => {
    const captured: Record<string, unknown>[] = [];
    const adapter = new AntigravityAdapter({ fetch: mockFetch(captured) });
    await collect(
      adapter.dispatch(
        request({ tools: [{ name: "web_search", jsonSchema: { type: "object" } }] } as Partial<CanonicalRequest>),
        candidate(),
        context(),
      ),
    );
    const tools = requestOf(envelopeOf(captured))["tools"] as Array<Record<string, unknown>>;
    expect(tools.some((tool) => "googleSearch" in tool)).toBe(true);
  });

  test("resetSession drops the conversation state", async () => {
    const captured: Record<string, unknown>[] = [];
    const adapter = new AntigravityAdapter({ fetch: mockFetch(captured) });
    await collect(adapter.dispatch(request(), candidate(), context()));
    expect(adapter.sessionStateSize()).toBe(1);
    adapter.resetSession("conv-1");
    expect(adapter.sessionStateSize()).toBe(0);
    await collect(adapter.dispatch(request(), candidate(), context()));
    // Fresh trajectory after reset: step restarts at 2 with a new signed id.
    expect(String(requestOf(envelopeOf(captured))["sessionId"])).toMatch(/^-\d+$/);
    expect(String(envelopeOf(captured)["requestId"]).endsWith("/2")).toBe(true);
  });
  test("fails over to sandbox once on retryable failure, never on auth errors", async () => {
    const urls: string[] = [];
    let generateCalls = 0;
    const flakyFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (!url.includes(":generateContent") && !url.includes(":streamGenerateContent")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      generateCalls++;
      if (generateCalls === 1) {
        return new Response(JSON.stringify({ error: "busy" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(RESPONSE_BODY), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const adapter = new AntigravityAdapter({ fetch: flakyFetch });
    const events = await collect(adapter.dispatch(request(), candidate(), context()));
    const terminal = events.at(-1) as { state?: string };
    expect(terminal.state).toBe("complete");
    const generateUrls = urls.filter((url) => url.includes(":generateContent"));
    expect(generateUrls).toHaveLength(2);
    expect(generateUrls[1]).toContain("daily-cloudcode-pa.sandbox.googleapis.com");

    // Auth failures fail closed without a sandbox attempt.
    const authGenerateUrls: string[] = [];
    const authFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes(":generateContent") && !url.includes(":streamGenerateContent")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      authGenerateUrls.push(url);
      return new Response(JSON.stringify({ error: "denied" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const authAdapter = new AntigravityAdapter({ fetch: authFetch });
    await expect(
      collect(authAdapter.dispatch(request(), candidate(), context())),
    ).rejects.toMatchObject({ status: 401 });
    expect(authGenerateUrls).toHaveLength(1);
  });
});

describe("antigravity session helpers", () => {  test("signedAntigravitySessionId passes numeric seeds through, signs text", () => {
    expect(signedAntigravitySessionId("12345")).toBe("12345");
    expect(signedAntigravitySessionId("-12345")).toBe("-12345");
    expect(signedAntigravitySessionId("conv-1")).toMatch(/^-\d+$/);
    // Text-seeded ids differ across texts (random low bits per derivation).
    expect(signedAntigravitySessionId("hello")).not.toBe(signedAntigravitySessionId("world"));
  });

  test("antigravityThinkingBudget follows effort tiers", () => {
    expect(antigravityThinkingBudget("gemini-2.5-pro")).toBeUndefined();
    expect(antigravityThinkingBudget("gemini-3-flash-low")).toBe(1_000);
    expect(antigravityThinkingBudget("claude-sonnet-4-5")).toBe(10_000);
  });
});
