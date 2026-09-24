import { describe, expect, test } from "bun:test";
import { captureProviderExchange } from "../../../src/transport/dispatch/attempt-finalize";
import type { ValidatedOutboundFetch } from "../../../src/providers/provider-registry";

/** A fetch that records nothing and returns a minimal JSON response. */
function stubFetch(): ValidatedOutboundFetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as ValidatedOutboundFetch;
}

function newSink(): { request: unknown; response: Promise<unknown> } {
  return { request: null, response: Promise.resolve(null) };
}

describe("captureProviderExchange header capture", () => {
  test("records the x-grok framing headers", async () => {
    // These are what make a Grok bug reproducible after the fact: the payload
    // store previously kept only the body, so the turn index could not be
    // inspected from captured traffic.
    const sink = newSink();
    const wrapped = captureProviderExchange(stubFetch(), sink);

    await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
      method: "POST",
      headers: {
        "x-grok-session-id": "session-abc",
        "x-grok-conv-id": "session-abc",
        "x-grok-turn-idx": "2",
        "x-grok-model-override": "grok-4.6",
        "x-grok-client-version": "1.0.40",
        "x-grok-client-identifier": "grok-shell",
      },
      body: JSON.stringify({ model: "grok-4.6" }),
    });

    const request = sink.request as { headers?: Record<string, string>; url: string };
    expect(request.headers).toMatchObject({
      "x-grok-session-id": "session-abc",
      "x-grok-conv-id": "session-abc",
      "x-grok-turn-idx": "2",
      "x-grok-model-override": "grok-4.6",
      "x-grok-client-version": "1.0.40",
      "x-grok-client-identifier": "grok-shell",
    });
  });

  test("never records credentials", async () => {
    // The capture store is read through the console, so a blanket header copy
    // would persist bearer tokens and API keys.
    const sink = newSink();
    const wrapped = captureProviderExchange(stubFetch(), sink);

    await wrapped("https://example.test/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer super-secret-token",
        "x-api-key": "sk-secret",
        cookie: "session=secret",
        "x-grok-turn-idx": "1",
      },
      body: "{}",
    });

    const headers = (sink.request as { headers?: Record<string, string> }).headers ?? {};
    expect(JSON.stringify(headers)).not.toContain("super-secret-token");
    expect(JSON.stringify(headers)).not.toContain("sk-secret");
    expect(JSON.stringify(headers)).not.toContain("secret");
    expect(headers["x-grok-turn-idx"]).toBe("1");
  });

  test("omits the headers key when nothing allowlisted is present", async () => {
    const sink = newSink();
    const wrapped = captureProviderExchange(stubFetch(), sink);

    await wrapped("https://example.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });

    const request = sink.request as Record<string, unknown>;
    expect("headers" in request).toBe(false);
    expect(request["url"]).toBe("https://example.test/v1/responses");
  });

  test("survives a request with no headers at all", async () => {
    const sink = newSink();
    const wrapped = captureProviderExchange(stubFetch(), sink);

    await wrapped("https://example.test/v1/responses", { method: "POST", body: "{}" });

    expect((sink.request as Record<string, unknown>)["headers"]).toBeUndefined();
  });

  test("captures the session headers the other providers use", async () => {
    const sink = newSink();
    const wrapped = captureProviderExchange(stubFetch(), sink);

    await wrapped("https://api.example.test/v1/messages", {
      method: "POST",
      headers: {
        "x-session-id": "sess-1",
        "x-claude-code-session-id": "cc-1",
        "user-agent": "claude-cli/2.0.0",
      },
      body: "{}",
    });

    expect((sink.request as { headers?: Record<string, string> }).headers).toMatchObject({
      "x-session-id": "sess-1",
      "x-claude-code-session-id": "cc-1",
      "user-agent": "claude-cli/2.0.0",
    });
  });
});
