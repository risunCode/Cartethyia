import { describe, expect, test } from "bun:test";

import { ProxyRequestPreparer } from "../../../src/transport/request/preparer";
import { GatewayError } from "../../../src/transport/gateway-error";
import type { RouteCandidate, RoutePlan } from "../../../src/transport/routing/route-model";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";

const authorization: ResolvedApiKey = {
  id: "key-tenant-a",
  tenantId: "tenant-a",
  scopes: ["routing:invoke"],
  snapshot: {
    api_key_id: "key-tenant-a",
    tenant_id: "tenant-a",
    provider_allowlist: ["codex"],
  },
};

const codexRouteCandidate: RouteCandidate = {
  provider_id: "codex",
  model_id: "gpt-5.6-sol",
  wire_family: "responses",
  endpoint: "/backend-api/codex/responses",
  provider_account_id: "tenant-a-codex-account",
  capability_profile: {},
};

const nonCodexRouteCandidate: RouteCandidate = {
  ...codexRouteCandidate,
  provider_id: "openai",
  provider_account_id: "other-provider-account",
};

describe("native compact routing preparation", () => {
  test("uses the tenant routing plan's Codex account candidates without touching the native body", async () => {
    let plannedTenant: string | null | undefined;
    const plan: RoutePlan = {
      revision: 1,
      requested_model: "gpt-5.6-sol",
      resolved_model: "gpt-5.6-sol",
      provider_id: "codex",
      candidates: [codexRouteCandidate, nonCodexRouteCandidate],
    };
    const preparer = new ProxyRequestPreparer({
      snapshotService: {
        getSnapshot: async () => ({ revision: 1 }),
      } as never,
      routingEngine: {
        plan: async (_model: string, _snapshot: unknown, tenantId?: string | null) => {
          plannedTenant = tenantId;
          return plan;
        },
      } as never,
      admissionService: {} as never,
    });

    const prepared = await preparer.prepareNativeCompact({
      model: "gpt-5.6-sol",
      authorization,
    });

    expect(plannedTenant).toBe("tenant-a");
    expect(prepared.candidates).toEqual([codexRouteCandidate]);
    expect(prepared.candidates[0]?.provider_account_id).toBe("tenant-a-codex-account");
  });

  test("rejects a tenant route that has no eligible Codex account candidate", async () => {
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async () => ({
          revision: 1,
          requested_model: "gpt-5.6-sol",
          resolved_model: "gpt-5.6-sol",
          provider_id: "openai",
          candidates: [nonCodexRouteCandidate],
        }),
      } as never,
      admissionService: {} as never,
    });

    await expect(preparer.prepareNativeCompact({ model: "gpt-5.6-sol", authorization })).rejects.toMatchObject({
      code: "capability_unsupported",
      status: 400,
    });
  });

  test("rejects a key whose provider policy excludes Codex before route planning", async () => {
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: { plan: async () => { throw new Error("must not plan"); } } as never,
      admissionService: {} as never,
    });
    await expect(preparer.prepareNativeCompact({
      model: "gpt-5.6-sol",
      authorization: {
        ...authorization,
        snapshot: { ...authorization.snapshot, provider_allowlist: ["openai"] },
      },
    })).rejects.toMatchObject({ code: "invalid_request", status: 403 });
  });
});

describe("canonical request preparation", () => {
  test("rejects a model the key is not allowed to use before route planning", async () => {
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: { plan: async () => { throw new Error("must not plan"); } } as never,
      admissionService: {} as never,
    });
    await expect(
      preparer.prepare({
        canonicalRequest: {
          model: "gpt-5.6-sol",
          messages: [],
          generation_controls: {},
          stream: false,
          source_surface: "chat",
        },
        authorization: {
          ...authorization,
          snapshot: { ...authorization.snapshot, model_allowlist: ["gpt-4o"] },
        },
        deadlineMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });

  test("degrades an unsupported extension content part and re-plans rather than failing", async () => {
    const plannedRequired: string[][] = [];
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async (
          _model: string,
          _snapshot: unknown,
          _tenantId: string,
          required: readonly string[],
        ): Promise<RoutePlan> => {
          plannedRequired.push([...required]);
          // A route that cannot serve the extension part: the preparer must
          // retry with the degraded variant instead of failing the request.
          if (required.some((capability) => capability.startsWith("extension:")))
            throw new GatewayError(
              "capability_unsupported",
              400,
              "no eligible route supports this request's capabilities",
            );
          return { candidates: [codexRouteCandidate] } as never;
        },
      } as never,
      admissionService: {} as never,
    });
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "hello" },
              { kind: "extension", name: "server_tool_use", payload: { id: "srv-1" } },
            ],
          },
        ],
        generation_controls: {},
        stream: false,
        source_surface: "messages",
      },
      authorization,
      deadlineMs: 60_000,
    });
    // The full requirement is planned first; only the degraded variant plans.
    expect(plannedRequired[0]).toContain("extension:server_tool_use");
    expect(plannedRequired[1]).not.toContain("extension:server_tool_use");
    expect(result.degradedCapabilities).toEqual(["extension:server_tool_use"]);
    // The unsupported part is stripped; the sibling text part survives.
    const content = result.canonicalRequest.messages[0]?.content ?? [];
    expect(content.some((part) => part.kind === "extension")).toBe(false);
    expect(content).toContainEqual({ kind: "text", text: "hello" });
  });

  test("applies the caller omit flag before planning, even when the route supports encrypted reasoning", async () => {
    const plannedRequired: string[][] = [];
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async (
          _model: string,
          _snapshot: unknown,
          _tenantId: string,
          required: readonly string[],
        ): Promise<RoutePlan> => {
          plannedRequired.push([...required]);
          return { candidates: [codexRouteCandidate] } as never;
        },
      } as never,
      admissionService: {} as never,
    });
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              { kind: "reasoning", payload: null, encrypted_content: "opaque-blob", summary: "prior thought" },
            ],
          },
        ],
        generation_controls: { "extension:omit_encrypted_reasoning": true },
        stream: false,
        source_surface: "responses",
      },
      authorization,
      deadlineMs: 60_000,
    });
    // One plan only, and it never required the encrypted capability: the strip
    // happened up front, not as a capability fallback.
    expect(plannedRequired).toHaveLength(1);
    expect(plannedRequired[0]).not.toContain("reasoning.encrypted_content");
    expect(result.degradedCapabilities).toEqual(["reasoning.encrypted_content"]);
    const content = result.canonicalRequest.messages[0]?.content ?? [];
    expect(content.some((part) => part.kind === "reasoning" && "encrypted_content" in part)).toBe(false);
  });

  test("projects against the chosen candidate, not the intersection of the fallback list", async () => {
    // The regression this test exists for: the chosen candidate is a `chat`
    // wire, which supports `stop`, while a later fallback in the same plan is a
    // `responses` wire, which does not. Projecting against the intersection of
    // every candidate rejected the request with `capability_unsupported` for a
    // control its own winning route can express — a universal router must send
    // the request, not fail it because some other candidate is less capable.
    //
    // The fallback MUST be a different wire family for this to discriminate:
    // with two `responses` candidates the intersection equals the chosen
    // candidate's capabilities and any projection passes.
    const chatCandidate: RouteCandidate = {
      ...codexRouteCandidate,
      provider_id: "acme",
      wire_family: "chat",
      endpoint: "/v1/chat/completions",
      provider_account_id: "chosen-account",
    };
    const responsesFallback: RouteCandidate = {
      ...codexRouteCandidate,
      provider_id: "openai",
      wire_family: "responses",
      provider_account_id: "fallback-account",
    };
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => ({ revision: 1 }) } as never,
      routingEngine: {
        plan: async (): Promise<RoutePlan> =>
          ({ candidates: [chatCandidate, responsesFallback] }) as never,
      } as never,
      admissionService: {} as never,
    });
    const result = await preparer.prepare({
      canonicalRequest: {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
        // `stop` is in the `chat` wire's generation-control set and absent from
        // `responses`, so only the chosen candidate can express it.
        generation_controls: { stop: ["END"] },
        stream: false,
        source_surface: "chat",
      },
      authorization,
      deadlineMs: 60_000,
    });
    expect(result.candidate.provider_id).toBe("acme");
    expect(result.canonicalRequest.generation_controls.stop).toEqual(["END"]);
  });
});
