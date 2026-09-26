import { describe, expect, test } from "bun:test";
import { getCodexAuthFilePath, getCodexResidency, resolveCodexStore } from "../../../../src/providers/integrations/codex/codex-identity";
import { CredentialResolver } from "../../../../src/providers/provider-registry";
import type { ProviderDispatchTarget, ProviderDispatchContext, ResolvedCredential } from "../../../../src/providers/provider-registry";
import { assertCodexOAuthCredential, CODEX_OAUTH_FAMILY_KINDS, CODEX_MODELS, createCodexAdapter } from "../../../../src/providers/integrations/codex/codex";
import { buildCodexIdentityHeaders } from "../../../../src/providers/integrations/codex/codex-headers";
import { _resetCodexVersion } from "../../../../src/providers/operations/client-versions";
import { escapeHarmonyControlTokens, mapReasoningEffortToWireTier } from "../../../../src/protocol/primitives";
import { applyCodexResponsesLiteShape, canonicalToCodexResponsesPayload } from "../../../../src/protocol/request/codex";
import { CodexStreamFrameProcessor } from "../../../../src/protocol/response/codex";
import { GatewayError } from "../../../../src/transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest, ToolDefinition } from "../../../../src/transport/canonical-model";
import { MessagesAdapter } from "../../../../src/transport/surface/messages/adapter";
import { captureRequest, dispatchContext } from "../../../helpers/provider-dispatch";

describe("Codex Integration", () => {
function fakeCanonicalRequest(
  overrides: Partial<CanonicalRequest> & Record<string, unknown> = {},
): CanonicalRequest {
  const base: CanonicalRequest = {
    model: "gpt-5-codex",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "responses",
  };
  return {
    ...base,
    ...(overrides as Partial<CanonicalRequest>),
  } as CanonicalRequest;
}

function fakeProviderDispatchTarget(
  wireFamily: ProviderDispatchTarget["wire_family"] = "responses",
  endpointPath = "/v1/responses",
): ProviderDispatchTarget {
  return {
    provider_id: "codex",
    model_id: "gpt-5-codex",
    wire_family: wireFamily,
    endpoint_path: endpointPath,
    capabilities: {},
  };
}

function credential(
  kind: ResolvedCredential["credential_kind"],
  secret?: string,
  accountId?: string,
): ResolvedCredential {
  return {
    provider_id: "codex",
    credential_kind: kind,
    ...(secret === undefined
      ? {}
      : { secret: new TextEncoder().encode(secret) }),
    ...(accountId === undefined ? {} : { account_id: accountId }),
  };
}

describe("codex store selection", () => {
  test("file store resolves to ~/.codex/auth.json", () => {
    const res = resolveCodexStore("file", {
      hasKeyring: false,
      homeDir: "/home/alice",
    });
    expect(res.resolved).toBe("file");
    expect(res.filePath).toBe("/home/alice/.codex/auth.json");
    expect(getCodexAuthFilePath("/home/alice")).toBe(
      "/home/alice/.codex/auth.json",
    );
  });

  test("keyring store selects OS credential store", () => {
    const res = resolveCodexStore("keyring", {
      hasKeyring: true,
      homeDir: "/home/alice",
    });
    expect(res.resolved).toBe("keyring");
    expect(res.filePath).toBeUndefined();
  });

  test("auto prefers keyring when available, otherwise file", () => {
    const withKeyring = resolveCodexStore("auto", {
      hasKeyring: true,
      homeDir: "/home/alice",
    });
    expect(withKeyring.resolved).toBe("keyring");
    const withoutKeyring = resolveCodexStore("auto", {
      hasKeyring: false,
      homeDir: "/home/bob",
    });
    expect(withoutKeyring.resolved).toBe("file");
    expect(withoutKeyring.filePath).toBe("/home/bob/.codex/auth.json");
  });
});

describe("codex OAuth-only credential guard", () => {
  test("accepts oauth, scoped_access_token, and workload_identity", () => {
    for (const kind of CODEX_OAUTH_FAMILY_KINDS) {
      const cred = credential(
        kind as ResolvedCredential["credential_kind"],
        "tok",
        "acc-1",
      );
      expect(() => assertCodexOAuthCredential(cred)).not.toThrow();
    }
  });

  test("rejects api_key and none with a 400 invalid_request", () => {
    for (const kind of ["api_key", "none"] as const) {
      expect(() =>
        assertCodexOAuthCredential(
          credential(kind, kind === "none" ? undefined : "sk-test", "acc-1"),
        ),
      ).toThrow(GatewayError);
    }
  });
});

describe("codex credential resolution", () => {
  test("resolver supports scoped_access_token and workload_identity for codex", () => {
    const resolver = new CredentialResolver();
    const scoped = resolver.resolve("codex", [
      {
        provider_id: "codex",
        credential_kind: "scoped_access_token",
        secret: "scoped-token",
        usable: true,
      },
    ]);
    expect(scoped.credential.credential_kind).toBe("scoped_access_token");
    const workload = resolver.resolve("codex", [
      {
        provider_id: "codex",
        credential_kind: "workload_identity",
        secret: "workload-token",
      },
    ]);
    expect(workload.credential.credential_kind).toBe("workload_identity");
  });

  test("ordered fallback: oauth primary unusable falls back to api_key alternative", () => {
    const resolver = new CredentialResolver();
    const result = resolver.resolve("codex", [
      {
        provider_id: "codex",
        credential_kind: "oauth",
        secret: "oauth-token",
        usable: false,
      },
      { provider_id: "codex", credential_kind: "api_key", secret: "api-token" },
    ]);
    expect(result.alternative_index).toBe(1);
    expect(result.credential.credential_kind).toBe("api_key");
  });

  test("browser-login oauth envelope is stripped", () => {
    const resolver = new CredentialResolver();
    const result = resolver.resolve("codex", [
      {
        provider_id: "codex",
        credential_kind: "oauth",
        secret: "Bearer chatgpt-oauth-token",
        token_envelope: "bearer",
      },
    ]);
    expect(new TextDecoder().decode(result.credential.secret)).toBe(
      "chatgpt-oauth-token",
    );
  });
});

describe("codex adapter headers and body", () => {
  test("sends native compact bodies unchanged to the fixed ChatGPT JSON endpoint", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body));
      return Response.json({ id: "cmp_1", compacted: true });
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      attestation: "attestation-token",
      installation_id_override: "install-compact",
    });
    const body = {
      model: "gpt-5-codex",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "keep this native" }] }],
      instructions: "retain all native compact fields",
      compact_metadata: { opaque: ["preserved"] },
    };
    const response = await adapter.compact(body, {
      credential: credential("oauth", "token", "account-1"),
      deadline: Date.now() + 5_000,
      abort_signal: new AbortController().signal,
    });
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(capturedBody).toEqual(body);
    expect(capturedHeaders["x-oai-attestation"]).toBe("attestation-token");
    expect(capturedHeaders["accept"]).toBe("application/json");
    expect(await response.json()).toEqual({ id: "cmp_1", compacted: true });
  });

  test("rejects API-key accounts from native compact", async () => {
    const adapter = createCodexAdapter({ provider_id: "codex", installation_id_override: "install-compact" });
    await expect(adapter.compact({ model: "gpt-5-codex", input: "x" }, {
      credential: credential("api_key", "key"),
      deadline: Date.now() + 5_000,
      abort_signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  test("emits User-Agent originator chatgpt-account-id openai-beta without tenant/gateway identity", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      const bodyText = init?.body as string | undefined;
      if (bodyText !== undefined)
        capturedBody = JSON.parse(bodyText) as Record<string, unknown>;
      const lowered = Object.fromEntries(
        Object.entries(capturedHeaders).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      );
      if (
        lowered["user-agent"] !== undefined &&
        String(lowered["user-agent"]).includes("Cartethyia")
      ) {
        throw new Error("leaked Cartethyia");
      }
      if (lowered["originator"] !== "codex_cli_rs")
        throw new Error("bad originator");
      return new Response(
        JSON.stringify({ id: "resp_1", model: "gpt-5-codex", output: [] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      codex_cli_version: "0.144.1",
    });
    const request = fakeCanonicalRequest();
    const candidate = fakeProviderDispatchTarget();
    const ctx: ProviderDispatchContext = {
      credential: credential("oauth", "oauth-secret", "acc-chatgpt-123"),
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
    };
    const events = [];
    for await (const ev of adapter.dispatch(request, candidate, ctx))
      events.push(ev);
    const headerLower = Object.fromEntries(
      Object.entries(capturedHeaders).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    );
    expect(headerLower["user-agent"]).toBe("codex_cli_rs/0.144.1");
    expect(headerLower["originator"]).toBe("codex_cli_rs");
    expect(headerLower["chatgpt-account-id"]).toBe("acc-chatgpt-123");
    expect(headerLower["openai-beta"]).toBe("responses=experimental");
    expect(headerLower["authorization"]).toBe("Bearer oauth-secret");
    for (const v of Object.values(headerLower)) {
      expect(String(v).toLowerCase().includes("cartethyia")).toBe(false);
      expect(String(v).toLowerCase().includes("tenant")).toBe(false);
    }
    expect(capturedBody["model"]).toBe("gpt-5-codex");
    expect(Array.isArray(capturedBody["input"])).toBe(true);
    expect(capturedBody["prompt_cache_key"]).toBeDefined();
    expect(typeof capturedBody["prompt_cache_key"]).toBe("string");
  });

  test("rejects API-key credentials at dispatch with a 400 invalid_request", async () => {
    const adapter = createCodexAdapter({ provider_id: "codex" });
    const request = fakeCanonicalRequest();
    const candidate = fakeProviderDispatchTarget("responses", "/backend-api/codex/responses");
    const ctx: ProviderDispatchContext = {
      credential: credential("api_key", "sk-test", "acc-api-1"),
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
    };
    await expect(async () => {
      for await (const _ of adapter.dispatch(request, candidate, ctx)) {
        // consume — should throw before yielding
      }
    }).toThrow(GatewayError);
  });

  test("dispatches to the ChatGPT backend for every OAuth-family credential", async () => {
    let capturedUrl = "";
    const fakeFetch = (async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ id: "resp_3", model: "gpt-5-codex", output: [] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
    });
    for (const kind of CODEX_OAUTH_FAMILY_KINDS) {
      const request = fakeCanonicalRequest();
      const candidate = fakeProviderDispatchTarget(
        "responses",
        "/backend-api/codex/responses",
      );
      const ctx: ProviderDispatchContext = {
        credential: credential(
          kind as ResolvedCredential["credential_kind"],
          "oauth-secret",
          "acc-1",
        ),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      };
      for await (const _ of adapter.dispatch(request, candidate, ctx)) {
        // consume
      }
      expect(capturedUrl.startsWith("https://chatgpt.com")).toBe(true);
    }
  });

  test("includes x-oai-attestation and canonical continuation headers", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      attestation: "attestation-token",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-1",
      conversation_id: "conv-1",
    } as unknown as Partial<CanonicalRequest>);
    const candidate = fakeProviderDispatchTarget();
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc-1",
    });
    const events = [];
    for await (const ev of adapter.dispatch(request, candidate, ctx))
      events.push(ev);
    const lower = requests[0]?.headers ?? {};
    const capturedBody = requests[0]?.body ?? {};
    expect(lower["x-oai-attestation"]).toBe("attestation-token");
    expect(lower["session-id"]).toBe("sess-1");
    expect(lower["conversation-id"]).toBe("conv-1");
    // Codex rejects these legacy identities as Responses body parameters;
    // continuation identity belongs in headers/client_metadata instead.
    expect(capturedBody["prompt_cache_key"]).toBe("sess-1");
    expect(capturedBody["session_id"]).toBeUndefined();
    expect(capturedBody["conversation_id"]).toBeUndefined();
  });

  test("buildCodexIdentityHeaders never includes tenant identity", () => {
    const headers = buildCodexIdentityHeaders({
      credential: credential("oauth", "tok", "acc-1"),
      version: "0.144.1",
      sessionId: "s1",
      conversationId: "c1",
    });
    const flat = Object.values(headers).join(" ").toLowerCase();
    expect(flat.includes("cartethyia")).toBe(false);
    expect(flat.includes("tenant")).toBe(false);
    expect(headers["originator"]).toBe("codex_cli_rs");
  });

  test("auth only from context.credential, never from model/body/query", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "clean-model",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
    });
    const request = fakeCanonicalRequest({ model: "gpt-5-codex?api_key=evil" });
    const candidate = fakeProviderDispatchTarget();
    await expect(async () => {
      const iter = adapter.dispatch(
        request,
        candidate,
        dispatchContext("codex", {
          credential_kind: "oauth",
          secret: new TextEncoder().encode("real-secret"),
          account_id: "acc-1",
        }),
      );
      for await (const _ of iter) {
        // consume
      }
    }).toThrow(GatewayError);
    const cleanRequest = fakeCanonicalRequest({ model: "gpt-5-codex" });
    const iter2 = adapter.dispatch(
      cleanRequest,
      candidate,
      dispatchContext("codex", {
        credential_kind: "oauth",
        secret: new TextEncoder().encode("real-secret"),
        account_id: "acc-1",
      }),
    );
    for await (const _ of iter2) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    expect(lower["authorization"]).toBe("Bearer real-secret");
  });

  test("rejects non-responses wire family with capability_unsupported", async () => {
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const request = fakeCanonicalRequest();
    const candidate = fakeProviderDispatchTarget("chat", "/v1/chat/completions");
    const ctx: ProviderDispatchContext = {
      credential: credential("oauth", "tok", "acc-1"),
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
    };
    let threw = false;
    try {
      const iter = adapter.dispatch(request, candidate, ctx);
      for await (const _ev of iter) {
        // should not reach
      }
    } catch (err: unknown) {
      threw = true;
      expect((err as GatewayError).code).toBe("capability_unsupported");
      expect((err as GatewayError).status).toBe(400);
    }
    expect(threw).toBe(true);
  });

  test("scoped_access_token and workload_identity dispatch like oauth over Responses", async () => {
    for (const kind of ["scoped_access_token", "workload_identity"] as const) {
      let capturedUrl = "";
      const fakeFetch = (async (input: string | URL | Request) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({ id: "r", model: "gpt-5-codex", output: [] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;
      const adapter = createCodexAdapter({
        provider_id: "codex",
        fetch: fakeFetch,
        chatgpt_base_url: "https://chatgpt.com",
      });
      const request = fakeCanonicalRequest();
      const candidate = fakeProviderDispatchTarget(
        "responses",
        "/backend-api/codex/responses",
      );
      const ctx: ProviderDispatchContext = {
        credential: credential(kind, `${kind}-token`, "acc-ent-1"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      };
      const events = [];
      for await (const ev of adapter.dispatch(request, candidate, ctx))
        events.push(ev);
      expect(capturedUrl.includes("chatgpt.com")).toBe(true);
      expect(events.length).toBeGreaterThan(0);
    }
  });
  test("maps Responses statuses to canonical stop reasons", async () => {
    for (const [status, expected] of [
      ["completed", "stop"],
      ["incomplete", "length"],
      ["failed", "error"],
      ["cancelled", "error"],
    ] as const) {
      const adapter = createCodexAdapter({
        provider_id: "codex",
        fetch: (async () =>
          new Response(JSON.stringify({ id: "r", status, output: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      });
      const events = [];
      for await (const event of adapter.dispatch(
        fakeCanonicalRequest(),
        fakeProviderDispatchTarget(),
        {
          credential: credential("oauth", "secret", "acc"),
          deadline: Date.now() + 5000,
          abort_signal: new AbortController().signal,
        },
      ))
        events.push(event);
      const terminal = events.find((event) => event.type === "terminal");
      expect(
        terminal?.type === "terminal" ? terminal.stop_reason : undefined,
      ).toBe(expected);
      expect(
        terminal?.type === "terminal"
          ? terminal.provider_stop_reason
          : undefined,
      ).toBe(status);
    }
  });

  test("normalizes Responses cache and reasoning usage", async () => {
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            usage: {
              input_tokens: 10,
              output_tokens: 8,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens_details: { reasoning_tokens: 3 },
            },
            output: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    const events = [];
    for await (const event of adapter.dispatch(
      fakeCanonicalRequest(),
      fakeProviderDispatchTarget(),
      {
        credential: credential("oauth", "secret", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    ))
      events.push(event);
    const terminal = events.find((event) => event.type === "terminal");
    expect(
      terminal?.type === "terminal"
        ? terminal.usage?.cached_input_tokens
        : undefined,
    ).toBe(4);
    expect(
      terminal?.type === "terminal"
        ? terminal.usage?.reasoning_tokens
        : undefined,
    ).toBe(3);
  });

  test("preserves reasoning encrypted content and requests it for reasoning turns", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "reasoning",
                summary: [{ text: "think" }],
                encrypted_content: "opaque-blob",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const request = fakeCanonicalRequest({
      reasoning: { effort: "high" },
      messages: [
        { role: "user", content: [{ kind: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            {
              kind: "reasoning",
              payload: "think",
              summary: "think",
              encrypted_content: "previous-blob",
            },
          ],
        },
      ],
    });
    const events = [];
    for await (const event of adapter.dispatch(request, fakeProviderDispatchTarget(), {
      credential: credential("oauth", "secret", "acc"),
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
    }))
      events.push(event);
    const reasoning = events.find(
      (event) =>
        event.type === "content_delta" && event.content.kind === "reasoning",
    );
    expect(
      reasoning?.type === "content_delta" &&
        reasoning.content.kind === "reasoning"
        ? reasoning.content.encrypted_content
        : undefined,
    ).toBe("opaque-blob");
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    const input = body["input"] as Array<Record<string, unknown>>;
    expect(
      input.some(
        (item) =>
          item.type === "reasoning" &&
          item.encrypted_content === "previous-blob",
      ),
    ).toBe(true);
    expect(
      input.some(
        (item) =>
          item.type === "message" &&
          item.content instanceof Array &&
          (item.content[0] as Record<string, unknown>).type === "output_text",
      ),
    ).toBe(false);
  });
});

describe("codex header parity P0/P1", () => {
  test("version header mirrors codex_cli_version (gap H version P0)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      codex_cli_version: "0.144.1",
      installation_id_override: "install-123",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-v",
    } as unknown as Partial<CanonicalRequest>);
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc-1",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    expect(lower["version"]).toBe("0.144.1");
    expect(lower["user-agent"]).toBe("codex_cli_rs/0.144.1");
  });

  test("awaits latest published CLI version before first dispatch", async () => {
    _resetCodexVersion();
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input).includes("registry.npmjs.org")) {
        return new Response(JSON.stringify({ version: "0.155.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ id: "r", model: "gpt-5-codex", output: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-latest",
    });
    const ctx: ProviderDispatchContext = {
      credential: credential("oauth", "oauth-secret", "acc-latest"),
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
    };
    for await (const _ of adapter.dispatch(
      fakeCanonicalRequest(),
      fakeProviderDispatchTarget(),
      ctx,
    )) {
      // consume
    }
    const lower = Object.fromEntries(
      Object.entries(capturedHeaders).map(([key, value]) => [
        key.toLowerCase(),
        String(value),
      ]),
    );
    expect(lower["user-agent"]).toBe("codex_cli_rs/0.155.1");
    expect(lower["originator"]).toBe("codex_cli_rs");
  });

  test("CODEX_MODELS exposes the current openai-codex SKU table", () => {
    for (const id of [
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-daybreak-blue-latest",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]) {
      expect(CODEX_MODELS.some((model) => model.modelId === id)).toBe(true);
    }
    const byId = new Map(CODEX_MODELS.map((model) => [model.modelId, model] as const));
    // The ChatGPT Codex backend caps the 6-generation and gpt-5.5 at 272k.
    expect(byId.get("gpt-6-astra")).toMatchObject({ contextLimit: 272_000, outputLimit: 128_000 });
    expect(byId.get("gpt-6-luna")).toMatchObject({ contextLimit: 272_000, outputLimit: 128_000 });
    expect(byId.get("gpt-daybreak-blue-latest")).toMatchObject({
      contextLimit: 272_000,
      outputLimit: 128_000,
    });
    expect(byId.get("gpt-5.5")).toMatchObject({ contextLimit: 272_000, outputLimit: 128_000 });
    // The 5.6 generation keeps the full 1M window.
    expect(byId.get("gpt-5.6-sol")).toMatchObject({ contextLimit: 1_000_000, outputLimit: 128_000 });
    expect(byId.get("gpt-5.6-terra")).toMatchObject({ contextLimit: 1_000_000, outputLimit: 128_000 });
  });

  test("emits canonical hyphenated identity headers", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-abc",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-xyz",
      thread_id: "thr-1",
      window_id: "win-1",
    } as unknown as Partial<CanonicalRequest>);
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    expect(lower["session-id"]).toBe("sess-xyz");
    expect(lower["thread-id"]).toBe("thr-1");
    expect(lower["x-codex-window-id"]).toBe("win-1");
    expect(lower["session_id"]).toBeUndefined();
    expect(lower["thread_id"]).toBeUndefined();
    expect(lower["window_id"]).toBeUndefined();
  });

  test("x-client-request-id mirrors session_id (gap H x-client-request-id P0)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-1",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-client-1",
    } as unknown as Partial<CanonicalRequest>);
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    expect(lower["x-client-request-id"]).toBe("sess-client-1");
  });

  test("x-codex-installation-id wired from identity.ts (gap H installation P1) via override", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-wire-999",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-inst",
    } as unknown as Partial<CanonicalRequest>);
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    expect(lower["x-codex-installation-id"]).toBe("install-wire-999");
  });

  test("x-codex-turn-metadata is ascii-escaped JSON (gap H turn-metadata P0)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-meta-1",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-meta",
      thread_id: "thr-meta",
      window_id: "win-meta",
      turn_id: "turn-meta",
    } as unknown as Partial<CanonicalRequest>);
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    const headerVal = lower["x-codex-turn-metadata"];
    expect(headerVal).toBeDefined();
    const parsed = JSON.parse(headerVal as string) as Record<string, unknown>;
    expect(parsed["installation_id"]).toBe("install-meta-1");
    expect(parsed["session_id"]).toBe("sess-meta");
    expect(parsed["thread_id"]).toBe("thr-meta");
    expect(parsed["window_id"]).toBe("win-meta");
    expect(parsed["turn_id"]).toBe("turn-meta");
    expect(parsed["request_kind"]).toBe("turn");
    for (let i = 0; i < (headerVal as string).length; i++) {
      expect((headerVal as string).charCodeAt(i) <= 127).toBe(true);
    }
  });

  test("x-codex-beta-features when enabled (gap H beta-features P1)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      enable_remote_compaction_v2: true,
      installation_id_override: "install-beta",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-beta",
    } as unknown as Partial<CanonicalRequest>);
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    expect(lower["x-codex-beta-features"]).toBe("remote_compaction_v2");
  });

  test("x-openai-subagent header plumbing as no-op stub when not configured (gap H subagent P1)", async () => {
    let captured: Record<string, string> = {};
    const fakeFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ id: "r", model: "gpt-5-codex", output: [] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    const adapterNoSub = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-sub-1",
    });
    for await (const _ of adapterNoSub.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-no-sub",
      } as unknown as Partial<CanonicalRequest>),
      fakeProviderDispatchTarget(),
      {
        credential: credential("oauth", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    )) {
      // consume
    }
    let lower = Object.fromEntries(
      Object.entries(captured).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    expect(lower["x-openai-subagent"]).toBeUndefined();
    const adapterWithSub = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      subagent: "test-subagent",
      installation_id_override: "install-sub-2",
    });
    for await (const _ of adapterWithSub.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-with-sub",
      } as unknown as Partial<CanonicalRequest>),
      fakeProviderDispatchTarget(),
      {
        credential: credential("oauth", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    )) {
      // consume
    }
    lower = Object.fromEntries(
      Object.entries(captured).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    expect(lower["x-openai-subagent"]).toBe("test-subagent");
  });

  test("x-openai-internal-codex-responses-lite header when responses_lite true (gap H lite P1)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      responses_lite: true,
      installation_id_override: "install-lite",
    });
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-lite",
      } as unknown as Partial<CanonicalRequest>),
      fakeProviderDispatchTarget(),
      ctx,
    )) {
      // consume
    }
    const lower = requests[0]?.headers ?? {};
    expect(lower["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  test("x-codex-routing-hint carries model and optional service tier for every OAuth-family credential", async () => {
    let captured: Record<string, string> = {};
    const fakeFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ id: "r", model: "gpt-5-codex", output: [] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    // OAuth without an explicit service tier: model only.
    const oauthAdapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-hint-1",
    });
    for await (const _ of oauthAdapter.dispatch(
      fakeCanonicalRequest({ model: "gpt-5-codex" }),
      fakeProviderDispatchTarget(),
      {
        credential: credential("oauth", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    )) {
      // consume
    }
    let lower = Object.fromEntries(
      Object.entries(captured).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    expect(lower["x-codex-routing-hint"]).toBe("model=gpt-5-codex");

    // OAuth with an explicit service tier: model;tier.
    for await (const _ of oauthAdapter.dispatch(
      fakeCanonicalRequest({
        model: "gpt-5-codex",
        generation_controls: { service_tier: "priority" },
      }),
      fakeProviderDispatchTarget(),
      {
        credential: credential("scoped_access_token", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    )) {
      // consume
    }
    lower = Object.fromEntries(
      Object.entries(captured).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    expect(lower["x-codex-routing-hint"]).toBe(
      "model=gpt-5-codex;tier=priority",
    );
  });

  test("captures x-codex-turn-state and x-models-etag and echoes on next request (gap H response headers P0/P1)", async () => {
    let firstHeaders: Record<string, string> | undefined;
    let secondHeaders: Record<string, string> | undefined;
    let callCount = 0;
    const fakeFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      callCount += 1;
      if (callCount === 1) {
        firstHeaders = (init?.headers as Record<string, string>) ?? {};
        return new Response(
          JSON.stringify({ id: "r1", model: "gpt-5-codex", output: [] }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-codex-turn-state": "turn-state-token-123",
              "x-models-etag": "etag-456",
            },
          },
        );
      }
      secondHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ id: "r2", model: "gpt-5-codex", output: [] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-turn",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-turn-echo",
    } as unknown as Partial<CanonicalRequest>);
    const ctx: ProviderDispatchContext = {
      credential: credential("oauth", "tok", "acc"),
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
    };
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume first
    }
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume second
    }
    const firstLower = Object.fromEntries(
      Object.entries(firstHeaders ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    );
    expect(firstLower["x-codex-turn-state"]).toBeUndefined();
    const secondLower = Object.fromEntries(
      Object.entries(secondHeaders ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    );
    expect(secondLower["x-codex-turn-state"]).toBe("turn-state-token-123");
    expect(secondLower["x-models-etag"]).toBe("etag-456");
  });

  test("parses 6 rate-limit headers on error and surfaces on GatewayError details (gap H rate-limit P0)", async () => {
    const fakeFetch = (async () => {
      return new Response(
        JSON.stringify({
          error: { code: "rate_limit_exceeded", message: "slow down" },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-codex-primary-used-percent": "85.5",
            "x-codex-primary-window-minutes": "60",
            "x-codex-primary-reset-at": "9999999999",
            "x-codex-secondary-used-percent": "40",
            "x-codex-secondary-window-minutes": "10",
            "x-codex-secondary-reset-at": "8888888888",
          },
        },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-rate",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-rate",
    } as unknown as Partial<CanonicalRequest>);
    let thrown: GatewayError | undefined;
    try {
      for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), {
        credential: credential("oauth", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      })) {
        // consume
      }
    } catch (err: unknown) {
      if (err instanceof GatewayError) thrown = err;
      else throw err;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.status).toBe(429);
    expect(thrown?.details["x_codex_primary_used_percent"]).toBe(85.5);
    expect(thrown?.details["rate_limits"]).toBeDefined();
    const rl = thrown?.details["rate_limits"] as Record<string, unknown>;
    const primary = rl["primary"] as Record<string, unknown>;
    expect(primary["used_percent"]).toBe(85.5);
    expect(primary["window_minutes"]).toBe(60);
    expect((rl["secondary"] as Record<string, unknown>)["used_percent"]).toBe(
      40,
    );
  });
});

describe("codex payload P0 fixes", () => {
  test("client_metadata envelope present on every outbound request (gap P3.1 P0)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-client-1",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-client",
      thread_id: "thr-client",
      window_id: "win-client",
      turn_id: "turn-client",
    } as unknown as Partial<CanonicalRequest>);
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const capturedBody = requests[0]?.body ?? {};
    const meta = capturedBody["client_metadata"] as
      Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.["x-codex-installation-id"]).toBe("install-client-1");
    expect(meta?.["session_id"]).toBe("sess-client");
    expect(meta?.["thread_id"]).toBe("thr-client");
    expect(meta?.["x-codex-window-id"]).toBe("win-client");
    expect(meta?.["turn_id"]).toBe("turn-client");
    const turnMetaJson = meta?.["x-codex-turn-metadata"] as string | undefined;
    expect(turnMetaJson).toBeDefined();
    expect(requests[0]?.headers["x-codex-turn-metadata"]).toBe(turnMetaJson);
    const parsed = JSON.parse(turnMetaJson as string) as Record<
      string,
      unknown
    >;
    expect(parsed["installation_id"]).toBe("install-client-1");
    expect(parsed["session_id"]).toBe("sess-client");
    expect(parsed["request_kind"]).toBe("turn");
  });

  test("Responses-Lite shaping hoists tools and strips detail (gap P3.5 P0)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      responses_lite: true,
      installation_id_override: "install-lite-2",
    });
    const baseRequest = fakeCanonicalRequest({
      session_id: "sess-lite-2",
      tools: [
        {
          name: "my_tool",
          description: "desc",
          input_schema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        } as unknown as ToolDefinition,
      ],
      tool_choice: { type: "tool", name: "my_tool" } as const,
      messages: [
        {
          role: "user",
          content: [{ kind: "text", text: "hello" }],
        },
      ],
    });
    (baseRequest.messages[0] as unknown as Record<string, unknown>).content = [
      { kind: "text", text: "hello" },
      {
        kind: "image",
        payload: { image_url: "http://example.com/img.jpg", detail: "high" },
      },
    ];
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(baseRequest, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const capturedBody = requests[0]?.body ?? {};
    expect(capturedBody["tools"]).toBeUndefined();
    expect(capturedBody["parallel_tool_calls"]).toBe(false);
    const input = capturedBody["input"] as Array<Record<string, unknown>>;
    const first = input[0] as Record<string, unknown>;
    expect(first["type"]).toBe("additional_tools");
    expect((first["tools"] as unknown[]).length).toBe(1);
    const hasDetail = JSON.stringify(capturedBody).includes('"detail"');
    expect(hasDetail).toBe(false);
    expect(capturedBody["tool_choice"]).toBe("required");
  });

  test("separates Codex-safe function-call id from call_id on outbound", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({
          id: "resp_comp",
          model: "gpt-5-codex",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_123",
              id: "item_456",
              name: "my_tool",
              arguments: '{"a":1}',
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-comp",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-comp",
      messages: [
        { role: "user", content: [{ kind: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "call_abc",
              name: "my_tool",
              arguments: { a: 1 },
            },
          ],
        },
        {
          role: "tool",
          content: [{ kind: "toolResult", call_id: "call_abc", content: "ok" }],
        },
      ],
    });
    const events: CanonicalEvent[] = [];
    for await (const ev of adapter.dispatch(request, fakeProviderDispatchTarget(), {
      credential: credential("oauth", "tok", "acc"),
      deadline: Date.now() + 5000,
      abort_signal: new AbortController().signal,
    }))
      events.push(ev);
    const input = capturedBody["input"] as Array<Record<string, unknown>>;
    const funcCall = input.find((i) => i["type"] === "function_call") as
      Record<string, unknown> | undefined;
    expect(String(funcCall?.["call_id"])).toBe("call_abc");
    expect(String(funcCall?.["id"])).toMatch(/^fc_[a-z0-9]+$/);
    const out = input.find((i) => i["type"] === "function_call_output") as
      Record<string, unknown> | undefined;
    expect(String(out?.["call_id"])).toBe("call_abc");
  });

  test("composite decode from piped call_id in stream and non-stream (gap P3.3)", async () => {
    const proc = new CodexStreamFrameProcessor(2);
    const events1 = proc.process({
      type: "response.function_call_arguments.delta",
      call_id: "call_piped|item_999",
      delta: '{"a":',
      name: "tool1",
    });
    expect(events1.length).toBe(1);
    expect((events1[0] as unknown as Record<string, unknown>)["call_id"]).toBe(
      "call_piped",
    );
    let captured = false;
    const fakeFetch = (async () => {
      captured = true;
      return new Response(
        JSON.stringify({
          id: "r",
          model: "gpt-5-codex",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "piped_call|item_xyz",
              name: "t",
              arguments: "{}",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-pipe",
    });
    const evs: CanonicalEvent[] = [];
    for await (const ev of adapter.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-pipe",
      } as unknown as Partial<CanonicalRequest>),
      fakeProviderDispatchTarget(),
      {
        credential: credential("oauth", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    ))
      evs.push(ev);
    expect(captured).toBe(true);
    const td = evs.find((e) => e.type === "tool_call_delta") as unknown as
      Record<string, unknown> | undefined;
    expect(td?.["call_id"]).toBe("piped_call");
  });

  test("reasoning item shape is summary_text array with id (gap P3.2 P0)", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-reason",
    });
    const request = fakeCanonicalRequest({
      session_id: "sess-reason",
      messages: [
        { role: "user", content: [{ kind: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            {
              kind: "reasoning",
              payload: "think",
              summary: "my summary",
              encrypted_content: "enc-blob",
            },
          ],
        },
      ],
      reasoning: { effort: "high" },
    });
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(request, fakeProviderDispatchTarget(), ctx)) {
      // consume
    }
    const capturedBody = requests[0]?.body ?? {};
    const input = capturedBody["input"] as Array<Record<string, unknown>>;
    const reasoningItem = input.find((i) => i["type"] === "reasoning") as
      Record<string, unknown> | undefined;
    expect(reasoningItem).toBeDefined();
    const summary = reasoningItem?.["summary"] as unknown[] | undefined;
    expect(Array.isArray(summary)).toBe(true);
    expect((summary?.[0] as Record<string, unknown>)["type"]).toBe(
      "summary_text",
    );
    expect((summary?.[0] as Record<string, unknown>)["text"]).toBe(
      "my summary",
    );
    const reasoningPayload = capturedBody["reasoning"] as
      Record<string, unknown> | undefined;
    expect(reasoningPayload?.["effort"]).toBe("high");
    expect(reasoningPayload?.["summary"]).toBe("auto");
  });

  test("incomplete status with tool call promotes to tool_use (gap P3.6 P0)", async () => {
    const fakeFetch = (async () => {
      return new Response(
        JSON.stringify({
          id: "r",
          model: "gpt-5-codex",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "function_call",
              call_id: "call_promote",
              name: "tool",
              arguments: '{"x":1}',
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-promote",
    });
    const evs: CanonicalEvent[] = [];
    for await (const ev of adapter.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-promote",
      } as unknown as Partial<CanonicalRequest>),
      fakeProviderDispatchTarget(),
      {
        credential: credential("oauth", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    ))
      evs.push(ev);
    const term = evs.find((e) => e.type === "terminal") as unknown as
      Record<string, unknown> | undefined;
    expect(term?.["stop_reason"]).toBe("tool_use");
    expect(term?.["provider_stop_reason"]).toBe("incomplete");
  });

  test("end_turn:false yields pause_turn (gap P3.6 P0) and stream processor handles output_item.added + done finalize", async () => {
    const proc = new CodexStreamFrameProcessor(2);
    const addedEvents = proc.process({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_1",
        type: "function_call",
        call_id: "call_a",
        name: "tool_a",
        arguments: '{"a":1}',
      },
    });
    expect(addedEvents.length).toBe(0);
    const deltaEvents = proc.process({
      type: "response.function_call_arguments.delta",
      call_id: "call_a",
      item_id: "item_1",
      output_index: 0,
      delta: '{"a":',
    });
    expect(deltaEvents.length).toBe(1);
    proc.process({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_1",
        type: "function_call",
        call_id: "call_a",
        name: "tool_a",
        arguments: '{"a":1,"b":2}',
      },
    });
    expect(proc.hasToolCall).toBe(true);
    proc.process({
      type: "response.completed",
      response: {
        status: "completed",
        id: "resp_123",
        usage: { input_tokens: 1, output_tokens: 1 },
        end_turn: false,
      },
    });
    const term = proc.terminalEvent() as unknown as Record<string, unknown>;
    // With tool call present, stop_reason remains tool_use (reference promotes tool_use first) but pause is signaled via stop_details
    expect(term["stop_reason"]).toBe("tool_use");
    expect((term["stop_details"] as Record<string, unknown>)?.["type"]).toBe(
      "pause_turn",
    );
    const fakeFetch = (async () => {
      return new Response(
        JSON.stringify({
          id: "r-pause",
          model: "gpt-5-codex",
          status: "completed",
          end_turn: false,
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "hello" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch: fakeFetch,
      installation_id_override: "install-pause",
    });
    const evs: CanonicalEvent[] = [];
    for await (const ev of adapter.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-pause",
      } as unknown as Partial<CanonicalRequest>),
      fakeProviderDispatchTarget(),
      {
        credential: credential("oauth", "tok", "acc"),
        deadline: Date.now() + 5000,
        abort_signal: new AbortController().signal,
      },
    ))
      evs.push(ev);
    const term2 = evs.find((e) => e.type === "terminal") as unknown as
      Record<string, unknown> | undefined;
    expect(term2?.["stop_reason"]).toBe("pause_turn");
  });

  test("reasoning effort mapping covers all wire tiers (gap P3.2 reasoning effort)", () => {
    expect(mapReasoningEffortToWireTier("minimal")).toBe("minimal");
    expect(mapReasoningEffortToWireTier("low")).toBe("low");
    expect(mapReasoningEffortToWireTier("medium")).toBe("medium");
    expect(mapReasoningEffortToWireTier("high")).toBe("high");
    expect(mapReasoningEffortToWireTier("xhigh")).toBe("xhigh");
    expect(mapReasoningEffortToWireTier("max")).toBe("max");
    expect(mapReasoningEffortToWireTier("none")).toBe("none");
    expect(mapReasoningEffortToWireTier(undefined)).toBeUndefined();
    expect(mapReasoningEffortToWireTier("unknown-tier")).toBe("medium");
  });

  test("system content rides in top-level instructions, never as a system input item", () => {
    // The Codex backend rejects `role: "system"` input items outright with
    // HTTP 400 `{"detail":"System messages are not allowed"}`, which is what a
    // Claude Code session over `/v1/messages` produced: the Messages surface
    // puts the client's whole system prompt in `request.system`, and the
    // builder turned each part into a system message. System content belongs in
    // the Responses `instructions` field.
    const payload = canonicalToCodexResponsesPayload({
      model: "gpt-6-luna",
      system: [{ kind: "text", text: "You are Claude Code." }],
      messages: [
        { role: "user", content: [{ kind: "text", text: "hi" }] },
        { role: "system", content: [{ kind: "text", text: "Second system turn." }] },
      ],
      generation_controls: {},
      stream: true,
      source_surface: "messages",
    });
    const input = payload["input"] as Array<Record<string, unknown>>;
    const roles = input.map((item) => item["role"]);
    expect(roles).not.toContain("system");
    expect(payload["instructions"]).toBe("You are Claude Code.\n\nSecond system turn.");
  });

  test("an Anthropic thinking block becomes a wire effort, never leaking canonical-only keys", () => {
    // A Messages client states reasoning as `thinking: { type, budget_tokens }`,
    // which the canonical model keeps as `thinking_type`/`budget_tokens`. The
    // Responses wire defines neither, and the builder used to forward the whole
    // canonical object verbatim when no effort was set — so Codex rejected the
    // request with HTTP 400. Derive the tier instead and emit only wire fields.
    const payload = canonicalToCodexResponsesPayload({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      reasoning: { thinking_type: "enabled", budget_tokens: 31_999 },
      stream: true,
      source_surface: "messages",
    });
    expect(payload["reasoning"]).toEqual({ effort: "max", summary: "auto" });
    const serialized = JSON.stringify(payload["reasoning"]);
    for (const canonicalOnly of [
      "budget_tokens",
      "thinking_type",
      "display",
      "task_budget",
      "prefix_mismatch_behavior",
    ]) {
      expect(serialized).not.toContain(canonicalOnly);
    }
  });

  test("a reasoning intent with no wire-mappable field omits the reasoning object", () => {
    // Nothing to translate: the field is absent rather than an empty object or
    // a verbatim canonical dump, so the upstream never sees an unknown key.
    const payload = canonicalToCodexResponsesPayload({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      reasoning: { thinking_type: "disabled" },
      stream: true,
      source_surface: "messages",
    });
    // `none` is a real wire tier, so it IS emitted — but as an effort, not the
    // canonical object.
    expect(payload["reasoning"]).toEqual({ effort: "none" });
  });

  test("buildCodexIdentityHeaders includes all parity headers deterministically", () => {
    const headers = buildCodexIdentityHeaders({
      credential: credential("oauth", "tok", "acc-123"),
      version: "0.144.1",
      sessionId: "sess-1",
      threadId: "thr-1",
      windowId: "win-1",
      turnId: "turn-1",
      parentTurnId: "parent-1",
      conversationId: "conv-1",
      installationId: "install-1",
      turnMetadataJson: '{"installation_id":"install-1","session_id":"sess-1"}',
      betaFeatures: "remote_compaction_v2",
      subAgent: "sub-1",
      responsesLite: true,
      turnState: "turn-state-123",
      modelsEtag: "etag-123",
    });
    const lower = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    expect(lower["version"]).toBe("0.144.1");
    expect(lower["session-id"]).toBe("sess-1");
    expect(lower["thread-id"]).toBe("thr-1");
    expect(lower["x-codex-window-id"]).toBe("win-1");
    expect(lower["x-client-request-id"]).toBe("sess-1");
    expect(lower["x-codex-installation-id"]).toBe("install-1");
    expect(lower["x-codex-turn-metadata"]).toBe(
      '{"installation_id":"install-1","session_id":"sess-1"}',
    );
    expect(lower["x-codex-beta-features"]).toBe("remote_compaction_v2");
    expect(lower["x-openai-subagent"]).toBe("sub-1");
    expect(lower["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(lower["x-codex-turn-state"]).toBe("turn-state-123");
    expect(lower["x-models-etag"]).toBe("etag-123");
    expect(lower["conversation-id"]).toBe("conv-1");
    expect(lower["turn-id"]).toBe("turn-1");
    expect(lower["parent-turn-id"]).toBe("parent-1");
  });
});

describe("codex P1 robustness backlog (gap report Phase 4)", () => {
  test("outbound custom tool call encodes input field, not arguments (gap P3.3 custom pipeline)", () => {
    const request = fakeCanonicalRequest({
      messages: [
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "call-custom-1",
              name: "grammar_tool",
              arguments: "some raw grammar input",
              call_kind: "custom",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              kind: "toolResult",
              call_id: "call-custom-1",
              content: "custom tool output",
              call_kind: "custom",
            },
          ],
        },
      ],
    });
    const payload = canonicalToCodexResponsesPayload(request);
    const input = payload["input"] as Array<Record<string, unknown>>;
    const call = input.find((i) => i["type"] === "custom_tool_call");
    const output = input.find((i) => i["type"] === "custom_tool_call_output");
    expect(call?.["input"]).toBe("some raw grammar input");
    expect(call?.["arguments"]).toBeUndefined();
    expect(output?.["output"]).toBe("custom tool output");
  });

  test("outbound computer tool call encodes action object and screenshot output (gap P3.3 computer pipeline)", () => {
    const request = fakeCanonicalRequest({
      messages: [
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "call-computer-1",
              name: "computer",
              arguments: { type: "click", x: 10, y: 20 },
              call_kind: "computer",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              kind: "toolResult",
              call_id: "call-computer-1",
              content: [
                { kind: "image", payload: "data:image/png;base64,AAAA" },
              ],
              call_kind: "computer",
            },
          ],
        },
      ],
    });
    const payload = canonicalToCodexResponsesPayload(request);
    const input = payload["input"] as Array<Record<string, unknown>>;
    const call = input.find((i) => i["type"] === "computer_call");
    const output = input.find((i) => i["type"] === "computer_call_output");
    expect(call?.["action"]).toEqual({ type: "click", x: 10, y: 20 });
    const outputPayload = output?.["output"] as
      Record<string, unknown> | undefined;
    expect(outputPayload?.["type"]).toBe("computer_screenshot");
    expect(outputPayload?.["image_url"]).toBe("data:image/png;base64,AAAA");
  });

  test("Claude Messages tool results survive the Codex Responses wire with their call IDs", () => {
    const request = new MessagesAdapter().parse({
      model: "gpt-5-codex",
      max_tokens: 256,
      messages: [
        { role: "user", content: "Write a text file." },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-first", name: "Bash", input: { command: "pwd" } },
            { type: "tool_use", id: "call-second", name: "Read", input: { path: "a.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-second", content: "contents" },
            { type: "tool_result", tool_use_id: "call-first", content: "C:/Users/Aria" },
          ],
        },
        { role: "user", content: "Now save the file." },
      ],
    });
    const input = canonicalToCodexResponsesPayload(request)["input"] as Array<Record<string, unknown>>;
    expect(input.filter((item) => item["type"] === "function_call_output")).toEqual([
      { type: "function_call_output", call_id: "call-first", output: "C:/Users/Aria" },
      { type: "function_call_output", call_id: "call-second", output: "contents" },
    ]);
    expect(input.map((item) => item["type"])).toEqual([
      "message", "function_call", "function_call",
      "function_call_output", "function_call_output", "message",
    ]);
  });

  test("orphaned tool call without a result gets a synthesized placeholder output (gap P3.5 orphan repair)", () => {
    const request = fakeCanonicalRequest({
      messages: [
        { role: "user", content: [{ kind: "text", text: "run the tool" }] },
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "orphan-call-1",
              name: "search",
              arguments: "{}",
            },
          ],
        },
        // Conversation aborted before a tool result arrived — no matching tool message.
      ],
    });
    const payload = canonicalToCodexResponsesPayload(request);
    const input = payload["input"] as Array<Record<string, unknown>>;
    const output = input.find(
      (i) =>
        i["type"] === "function_call_output" &&
        i["call_id"] === "orphan-call-1",
    );
    expect(output).toBeDefined();
    expect(String(output?.["output"])).toContain("No tool output found");
  });

  test("orphaned tool result without a matching call is folded into a user note (gap P3.5 orphan repair)", () => {
    const request = fakeCanonicalRequest({
      messages: [
        { role: "user", content: [{ kind: "text", text: "hi" }] },
        {
          role: "tool",
          content: [
            {
              kind: "toolResult",
              call_id: "unknown-call-1",
              content: "stray result from a branch that no longer exists",
            },
          ],
        },
      ],
    });
    const payload = canonicalToCodexResponsesPayload(request);
    const input = payload["input"] as Array<Record<string, unknown>>;
    expect(input.some((i) => i["type"] === "function_call_output")).toBe(false);
    const foldedNote = input.find(
      (i) =>
        i["type"] === "message" &&
        i["role"] === "user" &&
        JSON.stringify(i["content"]).includes("stray result from a branch"),
    );
    expect(foldedNote).toBeDefined();
  });

  test("escapeHarmonyControlTokens neutralizes reserved control-token spellings and is idempotent on clean text", () => {
    expect(escapeHarmonyControlTokens("hello <|channel|> world")).toBe(
      "hello <\\|channel\\|> world",
    );
    expect(escapeHarmonyControlTokens("<|start|><|message|><|end|>")).toBe(
      "<\\|start\\|><\\|message\\|><\\|end\\|>",
    );
    expect(
      escapeHarmonyControlTokens("plain text with no control tokens"),
    ).toBe("plain text with no control tokens");
  });

  test("Harmony control tokens are escaped in outbound text and tool call arguments (gap P3.5 escaping)", () => {
    const request = fakeCanonicalRequest({
      messages: [
        {
          role: "user",
          content: [{ kind: "text", text: "please echo <|channel|>" }],
        },
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "call-harmony-1",
              name: "echo",
              arguments: JSON.stringify({ text: "<|call|>leak" }),
            },
          ],
        },
      ],
    });
    const payload = canonicalToCodexResponsesPayload(request);
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("<|channel|>");
    expect(raw).not.toContain("<|call|>");
    expect(raw).toContain("<\\\\|channel\\\\|>");
  });

  test("whitespace-loop guard trips after the event threshold on a degenerate stream (gap 1.4 whitespace guard)", () => {
    const proc = new CodexStreamFrameProcessor(1);
    const frame = (delta: string): Record<string, unknown> => ({
      type: "response.function_call_arguments.delta",
      call_id: "call-loop-1",
      delta,
    });
    expect(() => {
      for (let i = 0; i < 260; i += 1) proc.process(frame("   "));
    }).toThrow();
  });

  test("whitespace-loop guard resets once real content arrives", () => {
    const proc = new CodexStreamFrameProcessor(1);
    const frame = (delta: string): Record<string, unknown> => ({
      type: "response.function_call_arguments.delta",
      call_id: "call-loop-2",
      delta,
    });
    for (let i = 0; i < 200; i += 1) proc.process(frame("   "));
    // Real content resets the whitespace tracker for this key.
    expect(() => proc.process(frame('{"q":1}'))).not.toThrow();
    for (let i = 0; i < 200; i += 1) proc.process(frame("   "));
    // Total whitespace-only run since reset stays under the threshold.
    expect(() => proc.process(frame("   "))).not.toThrow();
  });
});

describe("codex cache and Lite payloads", () => {
  test("projects canonical cache hints into deterministic prompt cache keys", () => {
    expect(
      canonicalToCodexResponsesPayload(
        fakeCanonicalRequest({ cache_hint: "stable_prefix" }),
      )["prompt_cache_key"],
    ).toBe("stable_prefix");
    expect(
      canonicalToCodexResponsesPayload(
        fakeCanonicalRequest({
          cache_hint: { kind: "breakpoint", list: [2, 5] },
        }),
      )["prompt_cache_key"],
    ).toBe("breakpoints:2,5");
  });

  test("Lite requests always replay reasoning across all turns", () => {
    const payload = canonicalToCodexResponsesPayload(
      fakeCanonicalRequest({
        reasoning: { effort: "high" },
      }),
      { responsesLite: true },
    );
    expect(payload["reasoning"]).toEqual({
      effort: "high",
      summary: "auto",
      context: "all_turns",
    });
    expect(
      canonicalToCodexResponsesPayload(fakeCanonicalRequest(), {
        responsesLite: true,
      })["reasoning"],
    ).toEqual({ context: "all_turns" });
  });
});

describe("codex residency", () => {
  function jwtWithAuthClaims(auth: Record<string, unknown>): string {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": auth }),
    ).toString("base64url");
    return `header.${payload}.signature`;
  }

  test("uses nested data residency before compute residency", () => {
    expect(
      getCodexResidency({
        accessToken: jwtWithAuthClaims({
          chatgpt_data_residency: " eu ",
          chatgpt_compute_residency: "us",
        }),
      }),
    ).toBe("eu");
  });

  test("falls back to nested compute residency and ignores blank claims", () => {
    expect(
      getCodexResidency({
        accessToken: jwtWithAuthClaims({
          chatgpt_data_residency: "   ",
          chatgpt_compute_residency: "us",
        }),
      }),
    ).toBe("us");
  });
});

describe("codex text verbosity", () => {
  test("projects generation_controls.verbosity into the nested text object", () => {
    const payload = canonicalToCodexResponsesPayload(
      fakeCanonicalRequest({ generation_controls: { verbosity: "low" } }),
    );
    expect(payload["text"]).toEqual({ verbosity: "low" });
  });

  test("omits text when no verbosity was requested", () => {
    expect(
      canonicalToCodexResponsesPayload(fakeCanonicalRequest())["text"],
    ).toBeUndefined();
  });

  test("adapter forwards configured verbosity upstream", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-verbosity",
    });
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-verbosity",
        generation_controls: { verbosity: "medium" },
      }),
      fakeProviderDispatchTarget(),
      ctx,
    )) {
      // consume
    }
    const capturedBody = requests[0]?.body ?? {};
    expect(capturedBody["text"]).toEqual({ verbosity: "medium" });
  });
});

describe("codex concurrent reasoning summaries", () => {
  test("stay off by default even when a summary is requested", () => {
    const payload = canonicalToCodexResponsesPayload(
      fakeCanonicalRequest({ reasoning: { effort: "high" } }),
    );
    expect(payload["stream_options"]).toBeUndefined();
  });

  test("emit sequential_cutoff when enabled and a summary is requested", () => {
    const payload = canonicalToCodexResponsesPayload(
      fakeCanonicalRequest({ reasoning: { effort: "high" } }),
      { concurrentReasoningSummaries: true },
    );
    expect(payload["stream_options"]).toEqual({
      reasoning_summary_delivery: "sequential_cutoff",
    });
  });

  test("are skipped when the request asks for no reasoning", () => {
    const payload = canonicalToCodexResponsesPayload(
      fakeCanonicalRequest({ reasoning: { effort: "none" } }),
      { concurrentReasoningSummaries: true },
    );
    expect(payload["stream_options"]).toBeUndefined();
  });

  test("adapter config opts into sequential_cutoff delivery", async () => {
    const { fetch, requests } = captureRequest({
      id: "r",
      model: "gpt-5-codex",
      output: [],
    });
    const adapter = createCodexAdapter({
      provider_id: "codex",
      fetch,
      installation_id_override: "install-summaries",
      concurrent_reasoning_summaries: true,
    });
    const ctx = dispatchContext("codex", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc",
    });
    for await (const _ of adapter.dispatch(
      fakeCanonicalRequest({
        session_id: "sess-summaries",
        reasoning: { effort: "high" },
      }),
      fakeProviderDispatchTarget(),
      ctx,
    )) {
      // consume
    }
    const capturedBody = requests[0]?.body ?? {};
    expect(capturedBody["stream_options"]).toEqual({
      reasoning_summary_delivery: "sequential_cutoff",
    });
  });
});

describe("codex reasoning mode projection", () => {
  test("forwards only the wire-valid pro mode", () => {
    const pro = canonicalToCodexResponsesPayload(
      fakeCanonicalRequest({ reasoning: { effort: "high", mode: "pro" } }),
    );
    expect((pro["reasoning"] as Record<string, unknown>)["mode"]).toBe("pro");
  });

  test("omits the canonical standard mode instead of sending it upstream", () => {
    const standard = canonicalToCodexResponsesPayload(
      fakeCanonicalRequest({ reasoning: { effort: "high", mode: "standard" } }),
    );
    expect(
      (standard["reasoning"] as Record<string, unknown>)["mode"],
    ).toBeUndefined();
  });
});

describe("codex Responses Lite detail stripping", () => {
  test("strips pinned detail from tool output collections", () => {
    const body: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: "c1",
          output: [
            {
              type: "input_image",
              image_url: "http://example.com/shot.jpg",
              detail: "high",
            },
          ],
        },
      ],
    };
    applyCodexResponsesLiteShape(body);
    const input = body["input"] as Array<Record<string, unknown>>;
    const toolOutput = input.find(
      (item) => item["type"] === "function_call_output",
    );
    const output = toolOutput?.["output"] as Array<Record<string, unknown>>;
    expect(output[0] && "detail" in output[0]).toBe(false);
    expect(JSON.stringify(body).includes('"detail"')).toBe(false);
  });

  /**
   * `image_url` is a *string* on the Responses wire. The builder forwarded the
   * canonical image part's opaque origin payload verbatim, so an Anthropic- or
   * Chat-origin image put an object on the wire and Codex rejected the whole
   * request with HTTP 400 ("expected an image URL, but got an object instead").
   * Each origin shape must resolve to a URL or a file id.
   */
  describe("image parts are normalized to the wire shape", () => {
    const imageMessage = (payload: unknown): CanonicalRequest =>
      fakeCanonicalRequest({
        messages: [{ role: "user", content: [{ kind: "image", payload }] } as never],
      });

    function imagePartOf(request: CanonicalRequest): Record<string, unknown> | undefined {
      const payload = canonicalToCodexResponsesPayload(request);
      const input = payload["input"] as Array<Record<string, unknown>>;
      const message = input.find((item) => item["type"] === "message");
      const content = message?.["content"] as Array<Record<string, unknown>> | undefined;
      return content?.[0];
    }

    test("an Anthropic base64 image becomes a data URL, not an object", () => {
      const part = imagePartOf(
        imageMessage({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        }),
      );
      expect(part?.["type"]).toBe("input_image");
      expect(part?.["image_url"]).toBe("data:image/png;base64,AAAA");
    });

    test("an Anthropic url image becomes its URL", () => {
      const part = imagePartOf(
        imageMessage({ type: "image", source: { type: "url", url: "https://x/b.png" } }),
      );
      expect(part?.["image_url"]).toBe("https://x/b.png");
    });

    test("an Anthropic file image becomes a file_id", () => {
      const part = imagePartOf(
        imageMessage({ type: "image", source: { type: "file", file_id: "file-1" } }),
      );
      expect(part?.["file_id"]).toBe("file-1");
      expect(part?.["image_url"]).toBeUndefined();
    });

    test("a nested Chat image_url object becomes its URL", () => {
      const part = imagePartOf(imageMessage({ image_url: { url: "https://x/a.png" } }));
      expect(part?.["image_url"]).toBe("https://x/a.png");
    });

    test("a flat url payload becomes its URL", () => {
      const part = imagePartOf(imageMessage({ url: "https://x/a.png" }));
      expect(part?.["image_url"]).toBe("https://x/a.png");
    });

    test("a detail hint is preserved alongside the resolved URL", () => {
      const part = imagePartOf(
        imageMessage({ image_url: { url: "https://x/d.png" }, detail: "high" }),
      );
      expect(part?.["image_url"]).toBe("https://x/d.png");
      expect(part?.["detail"]).toBe("high");
    });

    test("no image part ever puts a non-string image_url on the wire", () => {
      // The invariant the 400 came from, asserted across every origin shape.
      const shapes: unknown[] = [
        { image_url: { url: "https://x/a.png" } },
        { url: "https://x/a.png" },
        { type: "input_image", image_url: "https://x/a.png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "image", source: { type: "url", url: "https://x/b.png" } },
        { type: "image", source: { type: "file", file_id: "file-1" } },
        "https://x/c.png",
      ];
      for (const payload of shapes) {
        const payloadBody = canonicalToCodexResponsesPayload(imageMessage(payload));
        const input = payloadBody["input"] as Array<Record<string, unknown>>;
        const message = input.find((item) => item["type"] === "message");
        const content = (message?.["content"] as Array<Record<string, unknown>>) ?? [];
        for (const part of content) {
          if (part["type"] !== "input_image") continue;
          if (part["image_url"] !== undefined) {
            expect({ payload, imageUrl: typeof part["image_url"] }).toEqual({
              payload,
              imageUrl: "string",
            });
          }
        }
      }
    });

    test("a computer screenshot resolves the image part rather than forwarding it", () => {
      // The same wire constraint applies to a computer-use result's screenshot.
      const payload = canonicalToCodexResponsesPayload(
        fakeCanonicalRequest({
          messages: [
            {
              role: "assistant",
              content: [{ kind: "toolCall", call_id: "c1", name: "computer", call_kind: "computer" }],
            },
            {
              role: "user",
              content: [
                {
                  kind: "toolResult",
                  call_id: "c1",
                  call_kind: "computer",
                  content: [{ kind: "image", payload: { image_url: { url: "https://x/shot.png" } } }],
                },
              ],
            },
          ] as never,
        }),
      );
      const input = payload["input"] as Array<Record<string, unknown>>;
      const screenshot = input.find((item) => item["type"] === "computer_call_output");
      const output = screenshot?.["output"] as Record<string, unknown>;
      expect(output["type"]).toBe("computer_screenshot");
      expect(output["image_url"]).toBe("https://x/shot.png");
    });
  });
});
});
