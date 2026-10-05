import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/transport/canonical-model";
import { classifyUpstreamFailure } from "../../src/transport/failure-policy";
import { GatewayError } from "../../src/transport/gateway-error";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import {
  GROK_407_PROBE_PROMPT,
  grok407ProbeFailure,
} from "../../src/providers/discovery/probe-phases";

function textEvent(text: string): readonly CanonicalEvent[] {
  return [
    {
      type: "content_delta",
      sequence_number: 1,
      content: { kind: "text", text },
    },
  ];
}

describe("Grok 407 feature probe", () => {
  test("accepts 407 with Grok confidence metadata and a terminal error", () => {
    expect(
      grok407ProbeFailure({
        providerId: "grok",
        prompt: GROK_407_PROBE_PROMPT,
        events: textEvent("407 \\confidence{100}"),
        dispatchError: new Error("terminal metadata after content"),
      }),
    ).toBeUndefined();
  });

  test("parks a 202 response as Grok free-usage exhaustion", () => {
    const failure = grok407ProbeFailure({
      providerId: "grok",
      prompt: GROK_407_PROBE_PROMPT,
      events: textEvent("202"),
      dispatchError: undefined,
    });

    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure?.code).toBe("quota_exceeded");
    expect(failure?.details.providerCode).toBe("subscription:free-usage-exhausted");
    expect(failure?.details.providerStatus).toBe(202);
    expect(failure?.details.upstreamStatus).toBe(202);
  });

  test("parks any other failed feature probe for the same quota window", () => {
    const failure = grok407ProbeFailure({
      providerId: "grok",
      prompt: GROK_407_PROBE_PROMPT,
      events: [],
      dispatchError: new Error("upstream disconnected"),
    });

    if (failure === undefined) throw new Error("expected Grok feature failure");
    const policy = classifyUpstreamFailure(failure);
    const classification = classifyAccountError(failure, { ...policy, providerId: "grok" });
    expect(failure.code).toBe("quota_exceeded");
    expect(failure.details.providerCode).toBe("subscription:free-usage-exhausted");
    expect(classification.cooldownMs).toBe(24 * 60 * 60 * 1000);
  });

  test("uses a provider-stated reset duration instead of the fallback", () => {
    const prior = new GatewayError(
      "quota_exceeded",
      429,
      "quota will reset in 2 hours",
      {},
      "upstream",
    );
    const failure = grok407ProbeFailure({
      providerId: "grok",
      prompt: GROK_407_PROBE_PROMPT,
      events: [],
      dispatchError: prior,
    });

    if (failure === undefined) throw new Error("expected Grok feature failure");
    const policy = classifyUpstreamFailure(failure);
    const classification = classifyAccountError(failure, { ...policy, providerId: "grok" });
    expect(classification.cooldownMs).toBe(2 * 60 * 60 * 1000);
  });
});
