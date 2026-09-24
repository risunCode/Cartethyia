import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import { OPENAI_SPEC } from "../../src/providers/integrations/openai";
import {
  OPENCODE_FREE_SPEC,
  OPENCODE_ZEN_SPEC,
  OPENCODE_GO_SPEC,
} from "../../src/providers/integrations/opencode";
import { createAnthropicAdapter } from "../../src/providers/integrations/anthropic";
import { AIHUBMIX_SPEC } from "../../src/providers/integrations/aihubmix";
import { BAI_SPEC } from "../../src/providers/integrations/bai";
import { TOKENHARBOR_SPEC } from "../../src/providers/integrations/tokenharbor";
import { HERMES_SPEC } from "../../src/providers/integrations/hermes";
import { OPENROUTER_SPEC } from "../../src/providers/integrations/openrouter";
import { XIAOMIPG_SPEC, XIAOMITP_SPEC } from "../../src/providers/integrations/xiaomi";
import { ZAI_SPEC } from "../../src/providers/integrations/zai/spec";
import { CEREBRAS_SPEC } from "../../src/providers/integrations/cerebras";
import { createInferhubAdapter } from "../../src/providers/integrations/inferhub";
import { createApiKeyAdapter, type ApiKeyProviderSpec } from "../../src/providers/integrations/configured-provider";
import { GENERIC_API_KEY_SPECS } from "../../src/providers/integrations/configured-openai-providers";
import { ClaudeAdapter } from "../../src/providers/integrations/claude-code/claude";
import { createCodexAdapter } from "../../src/providers/integrations/codex/codex";
import type { ProviderDispatchTarget, ProviderAdapter } from "../../src/providers/provider-registry";
import {
  candidateFor,
  canonicalRequest,
  captureRequest,
  dispatchContext,
  dispatchJson,
} from "../helpers/provider-dispatch";

/** Builds a spec-shaped adapter factory for the matrix rows. */
function fromSpec(spec: ApiKeyProviderSpec): (fetchImpl?: typeof fetch) => ProviderAdapter {
  return (fetchImpl?: typeof fetch) => createApiKeyAdapter(spec, fetchImpl);
}

function canonicalFor(surface: CanonicalRequest["source_surface"]): CanonicalRequest {
  return canonicalRequest({ surface });
}

describe("provider matrix composition", () => {
  test("30.1 openai and anthropic dispatch with correct identity", async () => {
    const rows: readonly {
      readonly create: (fetchImpl: typeof fetch) => ProviderAdapter;
      readonly provider: ProviderDispatchTarget["provider_id"];
      readonly wire: ProviderDispatchTarget["wire_family"];
      readonly path: string;
      readonly authHeader: string;
      readonly expected: string;
    }[] = [
      {
        create: fromSpec(OPENAI_SPEC),
        provider: "openai",
        wire: "chat",
        path: "/v1/chat/completions",
        authHeader: "authorization",
        expected: "Bearer test-secret-token",
      },
      {
        create: createAnthropicAdapter,
        provider: "anthropic",
        wire: "messages",
        path: "/v1/messages",
        authHeader: "x-api-key",
        expected: "test-secret-token",
      },
    ];

    for (const row of rows) {
      const captured = await dispatchJson({
        create: row.create,
        candidate: candidateFor(row.provider, row.wire, row.path),
        request: canonicalFor(row.wire === "messages" ? "messages" : "chat"),
      });

      expect(captured.url).toContain(row.path);
      expect(captured.headers[row.authHeader]).toBe(row.expected);
      expect(Object.keys(captured.headers).join(",")).not.toContain("cartethyia");
    }
  });

  test("30.2 claude subscription OAuth with correct beta and identity", async () => {
    const { fetch, requests } = captureRequest({
      content: [{ type: "text", text: "hi" }],
      usage: {},
    });
    const adapter = new ClaudeAdapter({ fetch });
    // Real [CC] CLI turns always declare tools — exercises the
    // "agent" beta profile (claude-code-20250219 leads, structured-outputs
    // is absent, effort/fallback-credit trail) rather than the bare
    // "utility" profile a tool-less/thinking-less call would get.
    const req: CanonicalRequest = {
      ...canonicalFor("messages"),
      tools: [{ name: "read_file", jsonSchema: { type: "object", properties: {} } }],
    };
    const cand: ProviderDispatchTarget = {
      ...candidateFor("claude", "messages", "/v1/messages"),
      capabilities: { tools: true },
    };
    const ctx = dispatchContext("claude", {
      credential_kind: "oauth",
      secret: new TextEncoder().encode("oauth-token"),
      account_id: "acc-123",
    });
    for await (const _event of adapter.dispatch(req, cand, ctx)) {
      // drain
    }

    const captured = requests[0];
    expect(captured).toBeDefined();
    expect(captured?.headers["anthropic-beta"]).toBe(
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,fallback-credit-2026-06-01",
    );
    expect(captured?.headers["x-app"]).toBe("cli");
    expect(captured?.headers["authorization"]).toContain("Bearer");
  });

  test("30.3 codex OAuth-only: dispatches for OAuth family, rejects api_key/none", async () => {
    for (const kind of ["oauth", "scoped_access_token", "workload_identity"] as const) {
      const { fetch, requests } = captureRequest({
        output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      });
      const adapter = createCodexAdapter({ provider_id: "codex", fetch });
      const req = canonicalFor("responses");
      const cand = candidateFor("codex", "responses", "/backend-api/codex/responses");
      const ctx = dispatchContext("codex", {
        credential_kind: kind,
        secret: new TextEncoder().encode("oauth-token"),
      });
      for await (const _event of adapter.dispatch(req, cand, ctx)) {
        // drain
      }

      // The adapter warms its CLI-version cache through this same transport, so
      // the npm registry probe can be captured first — assert the ChatGPT
      // dispatch itself rather than request order.
      const dispatch = requests.find((request) => String(request.url).includes("chatgpt.com"));
      expect(dispatch).toBeDefined();
      expect(dispatch?.headers["originator"]).toBe("codex_cli_rs");
    }

    for (const kind of ["api_key", "none"] as const) {
      const adapter = createCodexAdapter({ provider_id: "codex" });
      const req = canonicalFor("responses");
      const cand = candidateFor("codex", "responses", "/backend-api/codex/responses");
      const ctx = dispatchContext("codex", {
        credential_kind: kind,
        ...(kind === "none" ? {} : { secret: new TextEncoder().encode("sk-test") }),
      });
      await expect(async () => {
        for await (const _ of adapter.dispatch(req, cand, ctx)) {
          // consume — should throw before yielding
        }
      }).toThrow();
    }
  });

  test("30.5 opencode family: free (no auth), zen (per-model wire selection), go (separate base)", async () => {
    // Free: unauthenticated — no Authorization header is ever sent, even
    // though a credential is technically resolvable.
    {
      const captured = await dispatchJson({
        create: fromSpec(OPENCODE_FREE_SPEC),
        candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
        context: dispatchContext("opencodeft", { credential_kind: "none" }),
      });
      expect(captured.url).toContain("/zen/v1/chat/completions");
      expect(captured.headers["authorization"]).toBeUndefined();
      expect(captured.headers["x-opencode-client"]).toBe("cli");
      expect(captured.headers["user-agent"]).toMatch(/^opencode\/\d+\.\d+\.\d+/);
    }

    // Zen: per-model wire selection across the two surfaces this factory can
    // actually serialize (chat/responses — "messages" is intentionally not
    // declared: the shared OpenAI-compatible factory cannot build an
    // Anthropic Messages-shaped payload), plus fresh session/request
    // correlation IDs on every dispatch (not one fixed value).
    {
      const seenSessionIds = new Set<string>();
      for (const [wire, path] of [
        ["responses", "/zen/v1/responses"],
        ["chat", "/zen/v1/chat/completions"],
      ] as const) {
        const captured = await dispatchJson({
          create: fromSpec(OPENCODE_ZEN_SPEC),
          candidate: candidateFor("opencodezen", wire, path),
          request: canonicalFor(wire === "responses" ? "responses" : "chat"),
        });
        expect(captured.url).toContain(path);
        expect(captured.headers["authorization"]).toContain("Bearer");
        const sessionId = captured.headers["x-opencode-session"];
        expect(typeof sessionId).toBe("string");
        expect(seenSessionIds.has(sessionId ?? "")).toBe(false);
        seenSessionIds.add(sessionId ?? "");
      }
    }

    // Go: separate /zen/go/v1 base, distinct from Zen's /zen/v1.
    {
      const captured = await dispatchJson({
        create: fromSpec(OPENCODE_GO_SPEC),
        candidate: candidateFor("opencodego", "chat", "/zen/go/v1/chat/completions"),
      });
      expect(captured.url).toContain("/zen/go/v1/chat/completions");
      expect(captured.url).not.toContain("/zen/v1/chat/completions");
    }
  });

  test("30.6 ollamacloud via its production spec row", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(GENERIC_API_KEY_SPECS.ollamacloud, fetchImpl),
      candidate: candidateFor("ollamacloud", "responses", "/v1/responses"),
      request: canonicalFor("responses"),
    });
    expect(captured.url).toContain("ollama.com");
    expect(captured.url).toContain("/responses");
    expect(captured.headers["authorization"]).toBe("Bearer test-secret-token");
  });

  test("30.7 cerebras is chat-only", async () => {
    const req = canonicalFor("chat");
    const candChat = candidateFor("cerebras", "chat", "/v1/chat/completions");
    const { fetch, requests } = captureRequest();
    const adapter = createApiKeyAdapter(CEREBRAS_SPEC, fetch);
    const ctx = dispatchContext("cerebras");
    for await (const _event of adapter.dispatch(req, candChat, ctx)) {
      // drain
    }

    expect(requests[0]?.url).toContain("api.cerebras.ai");

    const candResp = candidateFor("cerebras", "responses", "/v1/responses");
    await expect(
      (async () => {
        for await (const _ of adapter.dispatch(req, candResp, ctx)) {
        }
      })(),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  test("30.8 no-credential and alternative selection", async () => {
    const captured = await dispatchJson({
      create: fromSpec(OPENAI_SPEC),
      candidate: candidateFor("openai", "chat", "/v1/chat/completions"),
      context: dispatchContext("openai", { credential_kind: "none" }),
    });
    expect(captured.headers["authorization"]).toBeUndefined();
    expect(captured.headers["x-api-key"]).toBeUndefined();
  });
});

/**
 * One row per declarative api-key spec: the wire contract each spec row
 * actually produces (host, endpoint family, auth shape). Bespoke adapters
 * (Gemini, Qoder, CommandCode, Cloudflare, Perplexity, AgentRouter, the
 * Claude Messages legs) are covered by their own suites.
 */
describe("spec-driven api-key matrix", () => {
  const rows: readonly {
    readonly name: string;
    readonly create: (fetchImpl: typeof fetch) => ProviderAdapter;
    readonly provider: ProviderDispatchTarget["provider_id"];
    readonly wire: ProviderDispatchTarget["wire_family"];
    readonly path: string;
    readonly host: string;
    readonly auth: string | null;
    readonly credential?: { readonly secret: string; readonly credential_kind?: "api_key" | "none" };
    readonly extraHeaders?: Readonly<Record<string, string>>;
    readonly bodyCheck?: (body: Record<string, unknown>) => void;
  }[] = [
    {
      name: "openai",
      create: fromSpec(OPENAI_SPEC),
      provider: "openai",
      wire: "responses",
      path: "/v1/responses",
      host: "api.openai.com",
      auth: "Bearer test-secret-token",
    },
    {
      name: "aihubmix",
      create: fromSpec(AIHUBMIX_SPEC),
      provider: "aihubmix",
      wire: "chat",
      path: "/chat/completions",
      host: "aihubmix.com",
      auth: "Bearer test-secret-token",
    },
    {
      name: "tokenharbor",
      create: fromSpec(TOKENHARBOR_SPEC),
      provider: "tokenharbor",
      wire: "responses",
      path: "/responses",
      host: "tokenharbor.ai",
      auth: "Bearer test-secret-token",
    },
    {
      name: "hermes",
      create: fromSpec(HERMES_SPEC),
      provider: "hermes",
      wire: "chat",
      path: "/chat/completions",
      host: "inference-api.nousresearch.com",
      auth: "Bearer test-secret-token",
      bodyCheck: (body) => {
        expect(body["tags"]).toEqual(["product=hermes-agent", "client=hermes-client-v0.13.0"]);
      },
    },
    {
      name: "openrouter",
      create: fromSpec(OPENROUTER_SPEC),
      provider: "openrouter",
      wire: "chat",
      path: "/chat/completions",
      host: "openrouter.ai",
      auth: "Bearer test-secret-token",
      extraHeaders: { "http-referer": "https://endpoint-proxy.local", "x-title": "Endpoint Proxy" },
    },
    {
      name: "xiaomipg",
      create: fromSpec(XIAOMIPG_SPEC),
      provider: "xiaomipg",
      wire: "chat",
      path: "/chat/completions",
      host: "api.xiaomimimo.com",
      auth: "Bearer test-secret-token",
    },
    {
      name: "xiaomitp",
      create: fromSpec(XIAOMITP_SPEC),
      provider: "xiaomitp",
      wire: "chat",
      path: "/chat/completions",
      host: "token-plan-sgp.xiaomimimo.com",
      auth: "Bearer test-secret-token",
    },
    {
      name: "cerebras",
      create: fromSpec(CEREBRAS_SPEC),
      provider: "cerebras",
      wire: "chat",
      path: "/chat/completions",
      host: "api.cerebras.ai",
      auth: "Bearer test-secret-token",
    },
    {
      name: "zai",
      create: fromSpec(ZAI_SPEC),
      provider: "zai",
      wire: "chat",
      path: "/chat/completions",
      host: "api.z.ai",
      auth: "Bearer zai-json-token",
      credential: { secret: '{"accessToken":"zai-json-token"}' },
    },
    {
      name: "bai chat",
      create: fromSpec(BAI_SPEC),
      provider: "bai",
      wire: "chat",
      path: "/chat/completions",
      host: "api.b.ai",
      auth: "Bearer test-secret-token",
    },
    {
      name: "bai responses",
      create: fromSpec(BAI_SPEC),
      provider: "bai",
      wire: "responses",
      path: "/responses",
      host: "api.b.ai",
      auth: "Bearer test-secret-token",
    },
    {
      name: "inferhub chat leg",
      create: createInferhubAdapter,
      provider: "inferhub",
      wire: "chat",
      path: "/chat/completions",
      host: "api.inferhub.dev",
      auth: "Bearer test-secret-token",
    },
    {
      name: "opencodeft",
      create: fromSpec(OPENCODE_FREE_SPEC),
      provider: "opencodeft",
      wire: "chat",
      path: "/zen/v1/chat/completions",
      host: "opencode.ai",
      auth: null,
      credential: { secret: "", credential_kind: "none" },
    },
    {
      name: "opencodezen",
      create: fromSpec(OPENCODE_ZEN_SPEC),
      provider: "opencodezen",
      wire: "responses",
      path: "/zen/v1/responses",
      host: "opencode.ai",
      auth: "Bearer test-secret-token",
    },
    {
      name: "opencodego",
      create: fromSpec(OPENCODE_GO_SPEC),
      provider: "opencodego",
      wire: "chat",
      path: "/zen/go/v1/chat/completions",
      host: "opencode.ai",
      auth: "Bearer test-secret-token",
    },
    ...(
      [
        ["groq", "api.groq.com"],
        ["mistral", "api.mistral.ai"],
        ["siliconflow", "api.siliconflow.cn"],
        ["fireworks", "api.fireworks.ai"],
        ["nvidia", "integrate.api.nvidia.com"],
        ["gmi", "api.gmi-serving.com"],
        ["ollamacloud", "ollama.com"],
      ] as const
    ).map(([providerId, host]) => ({
      name: providerId,
      create: (fetchImpl: typeof fetch) =>
        createApiKeyAdapter(GENERIC_API_KEY_SPECS[providerId], fetchImpl),
      provider: providerId,
      wire: "chat" as const,
      path: "/chat/completions",
      host,
      auth: "Bearer test-secret-token",
    })),
  ];

  for (const row of rows) {
    test(`${row.name}: ${row.wire} dispatch on ${row.host}`, async () => {
      const captured = await dispatchJson({
        create: row.create,
        candidate: candidateFor(row.provider, row.wire, row.path),
        request: canonicalRequest({ surface: row.wire === "responses" ? "responses" : "chat" }),
        context: dispatchContext(
          row.provider,
          row.credential
            ? {
                credential_kind: row.credential.credential_kind ?? "api_key",
                secret: new TextEncoder().encode(row.credential.secret),
              }
            : {},
        ),
      });

      expect(captured.url).toContain(row.host);
      expect(captured.url).toContain(row.path);
      if (row.auth === null) expect(captured.headers["authorization"]).toBeUndefined();
      else expect(captured.headers["authorization"]).toBe(row.auth);
      for (const [name, value] of Object.entries(row.extraHeaders ?? {})) {
        expect(captured.headers[name]).toBe(value);
      }
      row.bodyCheck?.(captured.body);
    });
  }
});
