import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  VERSION_SOURCES,
  getQoderVersion,
  resolveQoderVersion,
  _resetQoderVersion,
} from "../../../src/providers/operations/client-versions";
import {
  MODERN_PROFILE,
  buildQoderRequest,
  createQoderAdapter,
  QODER_MODEL_CONFIGS,
  type QoderAuth,
} from "../../../src/providers/integrations/qoder";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../src/providers/provider-registry";
describe("Qoder dynamic version resolver", () => {
  beforeEach(() => {
    _resetQoderVersion();
  });
  afterEach(() => {
    _resetQoderVersion();
  });

  test("defaults to the pinned modern fallback", () => {
    expect(getQoderVersion()).toBe(VERSION_SOURCES.qoder.fallback);
  });

  test("resolves latest version from registry", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(VERSION_SOURCES.qoder.sources[0].url);
      return new Response(JSON.stringify({ version: "1.1.58" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resolved = await resolveQoderVersion(fakeFetch);
    expect(resolved).toBe("1.1.58");
    expect(getQoderVersion()).toBe("1.1.58");
  });

  test("falls back to pinned version on network failure", async () => {
    const failingFetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    const resolved = await resolveQoderVersion(failingFetch);
    expect(resolved).toBe(VERSION_SOURCES.qoder.fallback);
  });
});

describe("Qoder Modern Profile contracts", () => {
  test("declares modern endpoint and business parameters", () => {
    expect(MODERN_PROFILE.chatUrl).toContain("https://api2.qoder.sh");
    expect(MODERN_PROFILE.businessProduct).toBe("cli");
    expect(MODERN_PROFILE.businessType).toBe("agent");
    expect(MODERN_PROFILE.businessVersion).toBe("1.0.22");
    expect(MODERN_PROFILE.cosyScene).toBe("assistant");
    expect(MODERN_PROFILE.mirrorTopLevelSystem).toBe(true);
    expect(MODERN_PROFILE.sendBusinessHeaders).toBe(true);
    expect(MODERN_PROFILE.sendModelSourceHeaders).toBe(true);
    expect(MODERN_PROFILE.emptyAliyunUserType).toBe(true);
  });

  test("buildQoderRequest mirrors top-level system prompt into messages and chat_prompt", () => {
    const request: CanonicalRequest = {
      model: "lite",
      system: [{ kind: "text", text: "You are an expert engineer." }],
      messages: [{ role: "user", content: [{ kind: "text", text: "Fix the bug" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    const auth: QoderAuth = {
      userId: "u-123",
      userName: "tester",
      userType: "personal_standard",
      securityOauthToken: "tok-abc",
      refreshToken: "ref-xyz",
      machineId: "m-123",
    };
    const body = buildQoderRequest("lite", request, QODER_MODEL_CONFIGS["lite"]!, auth);
    expect(body["aliyun_user_type"]).toBe("");
    expect(body["chat_prompt"]).toBe("You are an expert engineer.");
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe("You are an expert engineer.");
    expect(messages[1]?.["role"]).toBe("user");
    expect(messages[1]?.["content"]).toBe("Fix the bug");
  });

  test("modern dispatch sends business headers, model headers, and modern endpoint", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl = "";
    let capturedBodyBytes: Uint8Array | null = null;

    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      if (init?.body instanceof Uint8Array) capturedBodyBytes = init.body;
      if (capturedUrl.includes("jobToken")) {
        return new Response(
          JSON.stringify({
            id: "u-test",
            name: "test-user",
            userType: "personal_standard",
            securityOauthToken: "oauth-tok-123",
            refreshToken: "refresh-tok-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const target: ProviderDispatchTarget = {
      provider_id: "qoder",
      model_id: "lite",
      wire_family: "chat",
      endpoint_path: "",
      capabilities: {},
    };
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "lite",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    for await (const _ of adapter.dispatch(request, target, ctx)) {
      // drain
    }

    expect(capturedUrl).toBe(MODERN_PROFILE.chatUrl);
    expect(capturedHeaders["cosy-business-product"]).toBe("cli");
    expect(capturedHeaders["cosy-business-type"]).toBe("agent");
    expect(capturedHeaders["cosy-scene"]).toBe("assistant");
    expect(capturedHeaders["x-model-key"]).toBe("lite");
    expect(capturedHeaders["x-model-source"]).toBe("system");
    expect(capturedBodyBytes).not.toBeNull();
  });

  test("a 403 inside the stream envelope is credential evidence, not a bare status line", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("jobToken")) {
        return new Response(
          JSON.stringify({
            id: "u-test",
            name: "test-user",
            userType: "personal_standard",
            securityOauthToken: "oauth-tok-123",
            refreshToken: "refresh-tok-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const frame = `data: ${JSON.stringify({
        statusCodeValue: 403,
        body: { error: { message: "Please run /login" } },
      })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const target: ProviderDispatchTarget = {
      provider_id: "qoder",
      model_id: "lite",
      wire_family: "chat",
      endpoint_path: "",
      capabilities: {},
    };
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "lite",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    let thrown: unknown;
    try {
      for await (const _ of adapter.dispatch(request, target, ctx)) void _;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "authentication_failed",
      status: 403,
      message: "Please run /login",
      details: { credentialEvidence: true, providerId: "qoder" },
    });
  });

  test("a 403 envelope whose body is a bare string still surfaces that string", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("jobToken")) {
        return new Response(
          JSON.stringify({ id: "u-test", securityOauthToken: "oauth-tok-123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const frame = `data: ${JSON.stringify({ statusCodeValue: 403, body: "Please run /login" })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "lite",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    let thrown: unknown;
    try {
      for await (const _ of adapter.dispatch(
        request,
        { provider_id: "qoder", model_id: "lite", wire_family: "chat", endpoint_path: "", capabilities: {} },
        ctx,
      )) void _;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 403, message: "Please run /login" });
  });
});

describe("Qoder pre-stream deadline release", () => {
  /**
   * The pre-stream deadline bounds TTFB only. Every other streaming adapter
   * releases the lifecycle once response headers arrive, with the comment
   * "the pre-stream deadline has served its purpose" (see `agentrouter.ts`,
   * `gemini.ts`, `antigravity.ts`, `commandcode.ts`), because from that point
   * the gateway's own stall/first-chunk watchdog owns the body.
   *
   * Qoder released only in `finally`, so its timer stayed armed across the
   * body. The failure is silent rather than loud: `decodeSseEvents` cancels its
   * reader on abort, so the read resolves as *done*, the loop exits, and
   * `qoderBodyToCanonicalEvents` then synthesizes a `state: "complete"`
   * terminal for a body it never finished reading. A healthy slow stream came
   * back as an empty successful response.
   */
  test("reads a body that outlives the pre-stream deadline", async () => {
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("jobToken")) {
        return new Response(
          JSON.stringify({
            id: "u-test",
            name: "test-user",
            userType: "personal_standard",
            securityOauthToken: "oauth-tok-123",
            refreshToken: "refresh-tok-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (!url.includes("agent_chat")) {
        return new Response(JSON.stringify({ version: "1.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const signal = init?.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream({
          async start(controller) {
            // The body arrives well after the deadline below has passed.
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (signal?.aborted) {
              controller.error(new Error("body aborted by the pre-stream deadline"));
              return;
            }
            const inner = JSON.stringify({
              choices: [{ delta: { content: "HELLO-FROM-BODY" }, finish_reason: null }],
            });
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ body: inner })}\n\ndata: [DONE]\n\n`),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const target: ProviderDispatchTarget = {
      provider_id: "qoder",
      model_id: "lite",
      wire_family: "chat",
      endpoint_path: "",
      capabilities: {},
    };
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      // Clears the auth prologue but not the body.
      deadline: Date.now() + 120,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "lite",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(request, target, ctx)) events.push(event);

    const text = events
      .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
      .join("");
    expect(text).toBe("HELLO-FROM-BODY");
  });
});
