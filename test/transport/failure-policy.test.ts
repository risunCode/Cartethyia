import { afterEach, describe, expect, test } from "bun:test";
import { fallbackRetryDelayMs, parseUpstreamBackoff, parseProviderResetDuration, parseAbsoluteResetTimestamp, classifyTerminalCategory, classifyUpstreamFailure, extractUpstreamMessage, upstreamProviderCode } from "../../src/transport/failure-policy";
import { GatewayError } from "../../src/transport/gateway-error";

function withEnvironment<T>(name: string, value: string | undefined, run: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

afterEach(() => {
  delete process.env.CARTETHYIA_FALLBACK_RETRY_BASE_MS;
  delete process.env.CARTETHYIA_FALLBACK_RETRY_CAP_MS;
});

describe("fallbackRetryDelayMs", () => {
  test("defaults stay within the 100ms base envelope", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = fallbackRetryDelayMs(0);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });

  test("defaults cap the exponential growth at 2000ms", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(fallbackRetryDelayMs(10)).toBeLessThanOrEqual(2_000);
    }
  });

  test("honors a configured base of 0 (immediate retry)", () => {
    withEnvironment("CARTETHYIA_FALLBACK_RETRY_BASE_MS", "0", () => {
      expect(fallbackRetryDelayMs(0)).toBe(0);
      expect(fallbackRetryDelayMs(3)).toBe(0);
    });
  });

  test("honors a configured cap below the exponential value", () => {
    withEnvironment("CARTETHYIA_FALLBACK_RETRY_BASE_MS", "1000", () =>
      withEnvironment("CARTETHYIA_FALLBACK_RETRY_CAP_MS", "50", () => {
        for (let i = 0; i < 50; i += 1) {
          expect(fallbackRetryDelayMs(0)).toBeLessThanOrEqual(50);
        }
      }),
    );
  });
});

describe("parseUpstreamBackoff", () => {
  function headers(entries: Record<string, string>): { get(name: string): string | null } {
    const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
  }

  test("prefers millisecond variants over second variants", () => {
    expect(parseUpstreamBackoff(headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(
      parseUpstreamBackoff(headers({ "retry-after-ms": "1500", "retry-after": "60" })),
    ).toBe(1500);
    expect(
      parseUpstreamBackoff(headers({ "x-ratelimit-reset-ms": "2500" })),
    ).toBe(2500);
  });

  test("falls back through retry-after and reset variants", () => {
    expect(parseUpstreamBackoff(headers({ "retry-after": "30" }))).toBe(30_000);
    expect(parseUpstreamBackoff(headers({}))).toBeNull();
    expect(parseUpstreamBackoff(headers({ "retry-after": "garbage" }))).toBeNull();
  });
});

describe("classifyUpstreamFailure retryability", () => {
  test("accounts_unavailable is retryable by code even with a 503 status", () => {
    const error = new GatewayError("accounts_unavailable", 503, "no available account");
    expect(classifyUpstreamFailure(error).retryable).toBe(true);
  });

  test("accounts_unavailable stays retryable with a non-5xx status (code, not status)", () => {
    const error = new GatewayError("accounts_unavailable", 200, "no available account");
    expect(classifyUpstreamFailure(error).retryable).toBe(true);
  });

  test("stream deadline is retryable before a stream is committed", () => {
    const error = new GatewayError("deadline_exceeded", 504, "upstream stream stalled");
    expect(classifyUpstreamFailure(error).retryable).toBe(true);
  });
});

describe("parseProviderResetDuration", () => {
  test("reads a relative duration", () => {
    expect(parseProviderResetDuration("quota will reset in 3 hours")).toBe(3 * 3600_000);
    expect(parseProviderResetDuration("try again in 30s")).toBe(30_000);
  });

  test("reads an absolute reset stamp with a UTC offset", () => {
    // The live WorkBuddy 429 shape: the provider states an absolute instant,
    // not a duration. A relative-only parser returned null, so the account
    // fell back to the 15-minute default and re-entered rotation while the
    // provider had parked it for the whole window.
    // Stamp is written in UTC+8 wall-clock, so the instant is 8h earlier than
    // the literal reading; add 8h so the true instant is a future 2h away.
    const stamp = new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    const parsed = parseProviderResetDuration(
      `usage exceeds frequency limit, your usage will reset at ${stamp} UTC+8`,
    );
    expect(parsed).not.toBeNull();
    const expected = Date.parse(`${stamp}Z`) - 8 * 3600_000 - Date.now();
    expect(Math.abs((parsed ?? 0) - expected)).toBeLessThan(2_000);
  });

  test("a bare UTC offset of zero is honored", () => {
    const target = Date.now() + 2 * 3600_000;
    const stamp = new Date(target).toISOString().slice(0, 19).replace("T", " ");
    const parsed = parseAbsoluteResetTimestamp(`resets at ${stamp} UTC`);
    expect(parsed).not.toBeNull();
    expect(Math.abs((parsed ?? 0) - 2 * 3600_000)).toBeLessThan(2_000);
  });

  test("a past stamp yields null so the caller keeps its default", () => {
    expect(parseAbsoluteResetTimestamp("will reset at 2020-01-01 00:00:00 UTC")).toBeNull();
  });

  test("returns null when the message states no reset at all", () => {
    expect(parseProviderResetDuration("usage exceeds frequency limit")).toBeNull();
  });
});

describe("upstream provider code and message extraction", () => {
  /**
   * WorkBuddy/CodeBuddy answer a broken tool history with HTTP 400 and an
   * envelope whose code is a **number** at the top level plus a more specific
   * string in `extError`, and whose text lives in `msg`:
   *
   *   {"code":11148,"msg":"tool calls and tool results do not match…",
   *    "extError":{"code":"tool_call_sequence_broken",…}}
   *
   * Reading only a nested string code dropped the code for this whole family,
   * and `extractUpstreamMessage` did not look at `msg`, so the operator saw an
   * empty message for a 400 that explained itself.
   */
  const WORKBUDDY_BROKEN_TOOLS = {
    code: 11148,
    msg: "tool calls and tool results do not match, please start a new conversation and retry",
    requestId: "f695ebb99bd34da481dc3126376d0f81",
    extError: {
      code: "tool_call_sequence_broken",
      message: "tool calls and tool results do not match, please start a new conversation and retry",
      type: "invalid_request_error",
      StatusCode: 400,
    },
  };

  test("prefers the specific nested code over the numeric envelope code", () => {
    expect(upstreamProviderCode(WORKBUDDY_BROKEN_TOOLS)).toBe("tool_call_sequence_broken");
  });

  test("keeps a numeric code as text when no string code exists", () => {
    expect(upstreamProviderCode({ code: 11148 })).toBe("11148");
  });

  test("still reads the classic nested string code", () => {
    expect(upstreamProviderCode({ error: { code: "invalid_api_key" } })).toBe("invalid_api_key");
  });

  test("returns undefined when the body carries no code", () => {
    expect(upstreamProviderCode({ message: "nope" })).toBeUndefined();
    expect(upstreamProviderCode("plain text")).toBeUndefined();
  });

  test("reads the human-readable message from the top-level msg field", () => {
    expect(extractUpstreamMessage(WORKBUDDY_BROKEN_TOOLS)).toBe(
      "tool calls and tool results do not match, please start a new conversation and retry",
    );
  });

  test("a broken tool history is a request error that must not punish the account", () => {
    // 11148 is the caller's history, not the credential or the upstream's
    // health: retrying another account would fail identically, and cooling the
    // account down would take a working credential out of rotation.
    const error = new GatewayError(
      "invalid_request",
      400,
      "tool calls and tool results do not match",
      { providerId: "workbuddy", providerCode: "tool_call_sequence_broken" },
      "upstream",
    );
    const policy = classifyUpstreamFailure(error);
    expect(policy.retryable).toBe(false);
    expect(policy.mutatesAccount).toBe(false);
    expect(policy.providerCode).toBe("tool_call_sequence_broken");
  });
});

describe("classifyTerminalCategory", () => {
  const signalOf = (reason: unknown): AbortSignal => {
    const controller = new AbortController();
    controller.abort(reason);
    return controller.signal;
  };
  const bareAbort = new DOMException("The operation was aborted", "AbortError");

  test("a GatewayError keeps its own code without consulting the signal", () => {
    const signal = new AbortController().signal;
    expect(classifyTerminalCategory(new GatewayError("quota_exceeded", 429, "rate limited"), signal)).toBe(
      "quota_exceeded",
    );
    expect(classifyTerminalCategory(new GatewayError("model_not_found", 404, "no route"), signalOf(bareAbort))).toBe(
      "model_not_found",
    );
  });

  test("a client disconnect is transport_closed, not unknown_error", () => {
    // Regression: request 8b4eead9-… cancelled by the client was recorded as
    // unknown_error / "the upstream failure could not be classified" even
    // though the abort signal clearly said who closed it.
    const signal = signalOf(new DOMException("client disconnect", "AbortError"));
    expect(classifyTerminalCategory(bareAbort, signal)).toBe("transport_closed");
  });

  test("the deadline timer's TimeoutError is deadline_exceeded", () => {
    const signal = signalOf(new DOMException("request deadline exceeded", "TimeoutError"));
    expect(classifyTerminalCategory(bareAbort, signal)).toBe("deadline_exceeded");
  });

  test("a GatewayError reason on the signal wins over the reader's AbortError", () => {
    // Stall watchdog: the signal carries deadline_exceeded while the reader
    // only surfaces a bare abort.
    const signal = signalOf(new GatewayError("deadline_exceeded", 504, "upstream stream stalled"));
    expect(classifyTerminalCategory(bareAbort, signal)).toBe("deadline_exceeded");
  });

  test("only a failure with no abort behind it stays unknown", () => {
    expect(classifyTerminalCategory(new TypeError("cannot read properties of undefined"), new AbortController().signal)).toBe(
      "unknown_error",
    );
  });
});
