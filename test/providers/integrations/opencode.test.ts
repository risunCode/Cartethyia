import { describe, expect, test } from "bun:test";
import type { ProviderDispatchTarget, ProviderAdapter } from "../../../src/providers/provider-registry";
import { candidateFor, canonicalRequest, dispatchContext, dispatchJson } from "../../helpers/provider-dispatch";
import { createApiKeyAdapter } from "../../../src/providers/integrations/configured-provider";
import { modelsDevCatalog } from "../../../src/providers/discovery/models-dev-catalog";
import {
  OPENCODE_FREE_MODELS,
  OPENCODE_FREE_SPEC,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_SPEC,
  OPENCODE_ZEN_MODELS,
  OPENCODE_ZEN_SPEC,
} from "../../../src/providers/integrations/opencode";

const TIERS: readonly {
  readonly id: ProviderDispatchTarget["provider_id"];
  readonly create: (fetchImpl: typeof fetch) => ProviderAdapter;
  readonly path: string;
  readonly forwardsCredential: boolean;
  readonly desktopHeaders: boolean;
}[] = [
  {
    id: "opencodeft",
    create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
    path: "/zen/v1/chat/completions",
    forwardsCredential: false,
    desktopHeaders: true,
  },
  {
    id: "opencodezen",
    create: (fetchImpl) => createApiKeyAdapter(OPENCODE_ZEN_SPEC, fetchImpl),
    path: "/zen/v1/chat/completions",
    forwardsCredential: true,
    desktopHeaders: true,
  },
  {
    id: "opencodego",
    create: (fetchImpl) => createApiKeyAdapter(OPENCODE_GO_SPEC, fetchImpl),
    path: "/zen/go/v1/chat/completions",
    forwardsCredential: true,
    desktopHeaders: false,
  },
];

describe("OpenCode provider header policy", () => {
  test("Free withholds the credential; Zen and Go forward it", async () => {
    for (const tier of TIERS) {
      const captured = await dispatchJson({
        create: tier.create,
        candidate: candidateFor(tier.id, "chat", tier.path),
        context:
          tier.id === "opencodeft"
            ? dispatchContext(tier.id, { credential_kind: "none" })
            : dispatchContext(tier.id),
      });

      expect(captured.url).toContain(tier.path);
      expect(captured.headers["authorization"] ?? null).toBe(
        tier.forwardsCredential ? "Bearer test-secret-token" : null,
      );
      expect(captured.headers["x-opencode-client"] ?? null).toBe(
        tier.desktopHeaders ? "cli" : null,
      );
    }
  });

  test("Zen mints fresh session and request correlation ids per dispatch", async () => {
    const ids = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const captured = await dispatchJson({
        create: (fetchImpl) => createApiKeyAdapter(OPENCODE_ZEN_SPEC, fetchImpl),
        candidate: candidateFor("opencodezen", "chat", "/zen/v1/chat/completions"),
      });
      const session = captured.headers["x-opencode-session"] ?? "";
      const request = captured.headers["x-opencode-request"] ?? "";
      const userAgent = captured.headers["user-agent"] ?? "";
      const project = captured.headers["x-opencode-project"];

      expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(session).toHaveLength(30);
      expect(request).toMatch(/^msg_[0-9a-f]{30}$/);
      expect(project).toBe("global");
      expect(userAgent).toMatch(/^opencode\/\d+\.\d+\.\d+/);
      const semverPart = userAgent.replace("opencode/", "");
      const [major, minor] = semverPart.split(".").map((n) => parseInt(n, 10));
      expect((major ?? 0) > 1 || ((major ?? 0) === 1 && (minor ?? 0) >= 18)).toBe(true);

      expect(ids.has(session)).toBe(false);
      ids.add(session);
    }
  });

  test("Go keeps API-key auth on the separate base and disables response storage", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_GO_SPEC, fetchImpl),
      candidate: candidateFor("opencodego", "responses", "/zen/go/v1/responses"),
      request: canonicalRequest({ surface: "responses" }),
    });

    expect(captured.url).toContain("/zen/go/v1/responses");
    expect(captured.headers["authorization"]).toBe("Bearer test-secret-token");
    expect(captured.headers["x-opencode-client"]).toBeUndefined();
    expect(captured.body["store"]).toBe(false);
  });

  test("drops incompatible prompt cache fields on Responses requests", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "responses", "/zen/v1/responses"),
      request: { ...canonicalRequest({ surface: "responses" }), cache_hint: "stable_prefix" },
      context: dispatchContext("opencodeft", { credential_kind: "none" }),
    });

    expect(captured.body["prompt_cache_options"]).toBeUndefined();
    expect(captured.body["prompt_cache_breakpoint"]).toBeUndefined();
    expect(captured.body["prompt_cache_key"]).toBeUndefined();
  });

  test("completes every OpenCode tool schema required list", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "responses", "/zen/v1/responses"),
      context: dispatchContext("opencodeft", { credential_kind: "none" }),
      request: {
        ...canonicalRequest({ surface: "responses" }),
        tools: [
          {
            name: "lookup",
            jsonSchema: {
              type: "object",
              properties: {
                command: { type: "string" },
                async: { type: "boolean" },
                options: {
                  type: "object",
                  properties: {
                    cwd: { type: "string" },
                    pty: { type: "boolean" },
                  },
                  required: ["cwd"],
                },
              },
              required: ["command"],
            },
          },
        ],
      },
    });
    const tools = captured.body.tools as Array<Record<string, unknown>>;
    const lookup = tools.find((tool) => tool.name === "lookup");
    const parameters = lookup?.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, unknown>;
    const options = properties.options as Record<string, unknown>;
    expect(parameters.required).toEqual(["command", "async", "options"]);
    expect(options.required).toEqual(["cwd", "pty"]);
  });

  test("backfills the read/bash agent fingerprint on Free Responses payloads", async () => {
    const free = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "responses", "/zen/v1/responses"),
      request: canonicalRequest({ surface: "responses" }),
    });
    const tools = free.body["tools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool["name"])).toEqual(["read", "bash"]);
    expect(free.body["stream"]).toBe(true);
  });

  test("preserves Studio tools while backfilling the Free agent fingerprint", async () => {
    const free = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      request: { ...canonicalRequest(), tools: [{ name: "printf", jsonSchema: { type: "object" } }] },
    });
    const tools = free.body["tools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => (tool["function"] as Record<string, unknown>)?.["name"])).toEqual([
      "printf",
      "read",
      "bash",
    ]);
  });

  test("never duplicates caller-declared agent tools on Free payloads", async () => {
    const free = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      request: {
        ...canonicalRequest(),
        tools: [
          { name: "read", jsonSchema: { type: "object" } },
          { name: "bash", jsonSchema: { type: "object" } },
        ],
      },
    });
    const tools = free.body["tools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => (tool["function"] as Record<string, unknown>)?.["name"])).toEqual([
      "read",
      "bash",
    ]);
  });
});

describe("OpenCode bundled catalog", () => {
  /**
   * Tenant aliases and fallback combos address this model by name
   * (`mimo-2.6-flash` → `opencodeft/mimo-v2.6-flash-free`). `seedBundledModels`
   * prunes every `builtin` row the catalog stops declaring, so dropping the row
   * silently turns each alias into `model_not_found` for a model the live
   * endpoint still serves.
   */
  test("declares the MiMo flash model every tier's aliases target", () => {
    for (const models of [OPENCODE_FREE_MODELS, OPENCODE_ZEN_MODELS]) {
      const mimo = models.find((model) => model.modelId === "mimo-v2.6-flash-free");

      expect(mimo).toBeDefined();
      expect(mimo?.wireFamily).toBe("chat");
      expect(mimo?.endpointPath).toBe("/zen/v1/chat/completions");
      expect(mimo?.contextLimit).toBe(200_000);
      expect(mimo?.outputLimit).toBe(32_000);
      expect(mimo?.modalities.input).toEqual(["text", "image", "document", "audio"]);
      expect(mimo?.reasoning).toBe(true);
    }
  });

  /**
   * A hardcoded `ctx`/`out` silently overrides the committed models.dev
   * snapshot, and a wrong limit is not cosmetic: an overstated context lets
   * through a request the upstream then rejects, while an understated one caps
   * what the model can serve. Every row the snapshot covers must therefore
   * agree with it; a row the snapshot predates must declare its own limits
   * instead of inheriting the generic default.
   */
  test("limits agree with the models.dev snapshot on every tier", () => {
    const tiers = [
      ["opencodeft", OPENCODE_FREE_MODELS, "opencode"],
      ["opencodezen", OPENCODE_ZEN_MODELS, "opencode"],
      ["opencodego", OPENCODE_GO_MODELS, "opencode-go"],
    ] as const;

    for (const [tier, models, providerId] of tiers) {
      for (const model of models) {
        const label = `${tier}/${model.modelId}`;
        const entry = modelsDevCatalog.resolve(providerId, model.modelId);
        if (!entry || entry.contextLimit == null || entry.outputLimit == null) {
          expect({ model: label, ctx: model.contextLimit }).not.toEqual({ model: label, ctx: null });
          expect({ model: label, out: model.outputLimit }).not.toEqual({ model: label, out: null });
          continue;
        }
        expect({ model: label, ctx: model.contextLimit, out: model.outputLimit }).toEqual({
          model: label,
          ctx: entry.contextLimit,
          out: entry.outputLimit,
        });
      }
    }
  });
});

