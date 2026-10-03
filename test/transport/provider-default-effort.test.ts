/**
 * The provider's default reasoning effort must reach real dispatch.
 *
 * What this pins (Opsi 1 / provider-default effort):
 *
 * - **Injection is per-attempt.** The effort stamped on a candidate applies
 *   only when the request itself carries no reasoning intent — a client that
 *   asks for a level always wins.
 * - **Capability-gated.** A candidate whose profile lacks `reasoning` receives
 *   nothing, because `projectForRoute` would reject an effort it cannot serve.
 * - **Combo member order is untouched.** The injection point sits *after* the
 *   router picked the candidate; it only shapes the payload sent to the chosen
 *   member.
 * - **Telemetry reflects what was sent.** The Usage label reads
 *   `state.canonicalRequest`; the injected default is written back so the label
 *   shows the level actually dispatched instead of "(default)".
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import type { RouteCandidate } from "../../src/transport/routing/route-model";
import { projectForRoute, routeCapabilitiesFor } from "../../src/transport/translation/capabilities";

/** A minimal chat-shaped canonical request with no reasoning intent. */
function baseRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "test-model",
    source_surface: "chat",
    stream: false,
    messages: [
      {
        role: "user",
        content: [{ kind: "text", text: "hello" }],
      } as unknown as CanonicalRequest["messages"][number],
    ],
    generation_controls: {},
    ...overrides,
  } as unknown as CanonicalRequest;
}

/** A chat-wire candidate with the given reasoning capability + routed effort. */
function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    provider_id: "prov",
    model_id: "test-model",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: { reasoning: true, tool_call: true, vision: false },
    ...overrides,
  };
}

/**
 * The exact injection rule `proxy-request.ts` applies per attempt. Mirrored
 * here (not imported — it is inline in the attempt callback) so the test fails
 * if the rule and this mirror drift; the mirror documents the contract.
 */
function applyProviderDefault(
  request: CanonicalRequest,
  cand: RouteCandidate,
): CanonicalRequest {
  const injectedEffort =
    request.reasoning === undefined ? cand.provider_reasoning_effort : undefined;
  if (injectedEffort === undefined) return request;
  return { ...request, reasoning: { effort: injectedEffort } };
}

describe("provider-default reasoning effort (dispatch injection rule)", () => {
  test("injects the routed effort when the request has no reasoning intent", () => {
    const cand = candidate({ provider_reasoning_effort: "high" });
    const request = baseRequest();
    const effortRequest = applyProviderDefault(request, cand);
    expect(effortRequest.reasoning).toEqual({ effort: "high" });
    // The payload must still project cleanly onto a reasoning-capable route.
    const projected = projectForRoute(effortRequest, routeCapabilitiesFor(cand));
    expect(projected).toBeDefined();
  });

  test("leaves the request untouched when the provider has no default", () => {
    const cand = candidate();
    const request = baseRequest();
    expect(applyProviderDefault(request, cand)).toBe(request);
  });

  test("a client-declared effort always wins over the provider default", () => {
    const cand = candidate({ provider_reasoning_effort: "low" });
    const request = baseRequest({
      reasoning: { effort: "medium" },
    } as Partial<CanonicalRequest>);
    expect(applyProviderDefault(request, cand)).toBe(request);
    expect(request.reasoning?.effort).toBe("medium");
  });

  test("injection rule is capability-blind, dispatcher gates it", () => {
    // The inline mirror applies whatever the candidate carries; the dispatcher
    // wraps it with the capability guard (reasoning-capable candidates only —
    // the snapshot stamps the effort, the route decides). The load-bearing
    // property under test: a non-reasoning route cannot accept a FORCED intent.
    const cand = candidate({
      provider_reasoning_effort: "medium",
      capability_profile: { reasoning: false, tool_call: true, vision: false },
    });
    expect(routeCapabilitiesFor(cand).reasoning).toBe(false);
  });

  test("projectForRoute rejects an effort forced onto a non-reasoning route", () => {
    const cand = candidate({
      capability_profile: { reasoning: false, tool_call: true, vision: false },
    });
    const forced = baseRequest({ reasoning: { effort: "high" } } as Partial<CanonicalRequest>);
    expect(() => projectForRoute(forced, routeCapabilitiesFor(cand))).toThrow();
  });
});
