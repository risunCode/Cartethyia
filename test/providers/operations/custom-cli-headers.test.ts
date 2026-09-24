import { describe, expect, test } from "bun:test";
import {
  buildCustomCodexCliHeaders,
  buildCustomClaudeCliHeaders,
  resolveCustomCliHeaders,
} from "../../../src/providers/operations/custom-cli-headers";
import { registerByokProviders } from "../../../src/providers/operations/provider-catalog-service";
import {
  ProviderRegistry,
  parseCustomProviderId,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
} from "../../../src/providers/provider-registry";
import type { CartethyiaDatabase } from "../../../src/persistence/postgres";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

describe("Custom Provider CLI Identity Headers", () => {
  test("builds Codex CLI headers with User-Agent and originator", () => {
    const headers = buildCustomCodexCliHeaders();
    expect(headers["user-agent"]).toContain("codex_cli_rs/");
    expect(headers["originator"]).toBe("codex_cli_rs");
  });

  test("builds Claude Code CLI headers with User-Agent and Stainless headers", () => {
    const headers = buildCustomClaudeCliHeaders();
    expect(headers["User-Agent"]).toContain("claude-cli/");
    expect(headers["x-app"]).toBe("cli");
    expect(headers["X-Stainless-Runtime"]).toBe("node");
    expect(headers["X-Stainless-Package-Version"]).toBeDefined();
  });

  test("resolveCustomCliHeaders branches by wire family", () => {
    const chat = resolveCustomCliHeaders("chat");
    expect(chat["originator"]).toBe("codex_cli_rs");

    const responses = resolveCustomCliHeaders("responses");
    expect(responses["originator"]).toBe("codex_cli_rs");

    const messages = resolveCustomCliHeaders("messages");
    expect(messages["x-app"]).toBe("cli");
    expect(messages["originator"]).toBeUndefined();
  });

  test("registerByokProviders applies CLI headers by default and allows disabling", async () => {
    const registry = new ProviderRegistry();
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => [
            {
              id: "custom-openai",
              baseUrl: "https://custom-openai.test",
              compatibilityProfile: {
                cli_identity: true,
                extra_headers: { "x-custom-test": "1" },
              },
            },
            {
              id: "custom-disabled",
              baseUrl: "https://custom-disabled.test",
              compatibilityProfile: {
                cli_identity: false,
                extra_headers: { "x-custom-disabled": "2" },
              },
            },
          ],
        }),
      }),
    } as unknown as CartethyiaDatabase;

    await registerByokProviders(registry, fakeDb);

    // 1. Enabled custom provider (default)
    const adapterOpenAI = await registry.resolve("custom-openai");
    expect(adapterOpenAI).toBeDefined();

    const capturedHeaders: Record<string, string>[] = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push((init?.headers as Record<string, string>) ?? {});
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

    const customOpenAiId = parseCustomProviderId("custom-openai");
    const target: ProviderDispatchTarget = {
      provider_id: customOpenAiId,
      model_id: "test-model",
      wire_family: "chat",
      endpoint_path: "/v1/chat/completions",
      capabilities: {},
    };
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: customOpenAiId,
        credential_kind: "api_key",
        secret: new TextEncoder().encode("key"),
      },
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
      outbound_fetch: fakeFetch,
    };
    const req: CanonicalRequest = {
      model: "test-model",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    for await (const _ of adapterOpenAI!.dispatch(req, target, ctx)) {}

    expect(capturedHeaders[0]?.["originator"]).toBe("codex_cli_rs");
    expect(capturedHeaders[0]?.["user-agent"]).toContain("codex_cli_rs/");
    expect(capturedHeaders[0]?.["x-custom-test"]).toBe("1");

    // 2. Disabled custom provider (cli_identity: false)
    const adapterDisabled = await registry.resolve("custom-disabled");
    const capturedDisabledHeaders: Record<string, string>[] = [];
    const fakeDisabledFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedDisabledHeaders.push((init?.headers as Record<string, string>) ?? {});
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

    const customDisabledId = parseCustomProviderId("custom-disabled");
    const disabledCtx: ProviderDispatchContext = {
      ...ctx,
      credential: {
        provider_id: customDisabledId,
        credential_kind: "api_key",
        secret: new TextEncoder().encode("key"),
      },
      outbound_fetch: fakeDisabledFetch,
    };
    const disabledTarget: ProviderDispatchTarget = {
      ...target,
      provider_id: customDisabledId,
    };

    for await (const _ of adapterDisabled!.dispatch(req, disabledTarget, disabledCtx)) {}

    expect(capturedDisabledHeaders[0]?.["originator"]).toBeUndefined();
    expect(capturedDisabledHeaders[0]?.["x-custom-disabled"]).toBe("2");
  });
});
