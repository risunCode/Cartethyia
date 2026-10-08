/**
 * `terminalFailure` — the decision that turns a finished upstream stream into
 * either a success or an error the client is told about.
 *
 * Both dispatch paths route through it: the streaming branch calls it with
 * `{ truncated: true }` once the iterator is exhausted, and the non-streaming
 * branch calls it bare. It decides three things that are each a way a real
 * answer gets misreported:
 *
 * 1. **A stream with no terminal event is an upstream failure.** A provider
 *    that closes the socket mid-answer must not read as a completed turn, or
 *    the client believes a truncated answer was whole and telemetry bills it
 *    as a success.
 * 2. **A `failed` terminal carries the upstream's own message.** Providers
 *    report the real cause in `stop_details` (a quota note, a content-policy
 *    reason); replacing it with a generic string loses the only diagnostic the
 *    operator gets.
 * 3. **An `aborted` terminal means different things on the two paths.** On the
 *    stream path it is a truncation the caller handles, so `terminalFailure`
 *    returns `undefined` and lets the caller's own truncation logic speak. On
 *    the non-streaming path there is no such caller, so it is a real 499.
 *
 * It had no test before this file, which is why the third case in particular
 * is worth pinning: the same terminal state yields opposite verdicts depending
 * on a caller-supplied flag, and nothing recorded that.
 */
import { describe, expect, test } from "bun:test";
import { terminalFailure } from "../../src/transport/dispatch/attempt-finalize";
import { GatewayError } from "../../src/transport/gateway-error";

describe("terminalFailure", () => {
  describe("no terminal event at all", () => {
    test("is an upstream 502, not a success", () => {
      const error = terminalFailure(undefined);
      expect(error).toBeInstanceOf(GatewayError);
      expect(error?.code).toBe("transport_unavailable");
      expect(error?.status).toBe(502);
      // The upstream's stream is what ended without a verdict, so the blame
      // belongs to the upstream rather than to the gateway.
      expect(error?.origin).toBe("upstream");
    });

    test("is an upstream 502 whether or not the caller flags truncation", () => {
      // Truncation changes the *handling* of an aborted terminal, not the
      // verdict on a stream that never terminated.
      expect(terminalFailure(undefined, { truncated: true })?.code).toBe("transport_unavailable");
      expect(terminalFailure(undefined, { truncated: false })?.code).toBe("transport_unavailable");
    });
  });

  describe("a failed terminal", () => {
    test("is an upstream 502", () => {
      const error = terminalFailure({ state: "failed" });
      expect(error?.code).toBe("transport_unavailable");
      expect(error?.status).toBe(502);
      expect(error?.origin).toBe("upstream");
    });

    test("surfaces the provider's own stop reason as the provider code", () => {
      const error = terminalFailure({
        state: "failed",
        provider_stop_reason: "content_filter",
      });
      expect(error?.details["provider_code"]).toBe("content_filter");
    });

    test("uses the provider's message when stop_details carries one", () => {
      // The real cause is the only diagnostic an operator gets; a generic
      // "upstream request failed" throws it away.
      const error = terminalFailure({
        state: "failed",
        stop_details: { message: "your quota is exhausted for this month" },
      });
      expect(error?.message).toBe("your quota is exhausted for this month");
    });

    test("falls back to a generic message when stop_details carries none", () => {
      const error = terminalFailure({ state: "failed", stop_details: { code: "x" } });
      expect(error?.message).toBe("upstream request failed");
    });

    test("ignores a non-string message in stop_details", () => {
      // `stop_details` is provider JSON, so `message` is not guaranteed to be
      // a string; a non-string must not become the public error text.
      const error = terminalFailure({ state: "failed", stop_details: { message: 42 } });
      expect(error?.message).toBe("upstream request failed");
    });

    test("merges the whole stop_details into the error details", () => {
      const error = terminalFailure({
        state: "failed",
        stop_details: { retry_after_ms: 5000, scope: "tenant" },
      });
      expect(error?.details["retry_after_ms"]).toBe(5000);
      expect(error?.details["scope"]).toBe("tenant");
    });

    test("the provider code is overridable by a stop_details key of the same name", () => {
      // Measured: `Object.assign(details, stop_details)` runs after the
      // provider_code is set, so a stop_details.provider_code wins. Pinned so
      // the precedence is a decision rather than an accident.
      const error = terminalFailure({
        state: "failed",
        provider_stop_reason: "from_stop_reason",
        stop_details: { provider_code: "from_details" },
      });
      expect(error?.details["provider_code"]).toBe("from_details");
    });
  });

  describe("an aborted terminal", () => {
    test("on the streaming path it is left to the caller's truncation handling", () => {
      // The stream branch knows the difference between "ended early" and
      // "never terminated" and reports it itself; returning an error here
      // would double-report the same stream.
      expect(terminalFailure({ state: "aborted" }, { truncated: true })).toBeUndefined();
    });

    test("on the non-streaming path it is a 499 transport_closed", () => {
      const error = terminalFailure({ state: "aborted" });
      expect(error?.code).toBe("transport_closed");
      expect(error?.status).toBe(499);
    });

    test("the truncation flag alone decides it", () => {
      // The same terminal state, opposite verdicts — this is the case worth
      // recording, because nothing else expresses it.
      const aborted = { state: "aborted" } as const;
      expect(terminalFailure(aborted, { truncated: true })).toBeUndefined();
      expect(terminalFailure(aborted, { truncated: false })).toBeInstanceOf(GatewayError);
    });
  });

  describe("a successful terminal", () => {
    test("a complete state is not a failure", () => {
      expect(terminalFailure({ state: "complete", stop_reason: "stop" })).toBeUndefined();
    });

    test("an unrecognised state is not treated as a failure", () => {
      // Only the states this function knows are failures. A future terminal
      // state must not silently become an error, which would fail healthy
      // requests the moment a decoder adds one.
      expect(terminalFailure({ state: "some_future_state" })).toBeUndefined();
    });
  });
});

describe("errorClientResponseBody", () => {
  test("mirrors the public wire envelope for gateway errors", async () => {
    const { errorClientResponseBody } = await import("../../src/transport/dispatch/attempt-finalize");
    const parsed = JSON.parse(
      errorClientResponseBody(new GatewayError("platform_unavailable", 502, "Upstream blew up", {}, "upstream")),
    ) as { error: Record<string, unknown> };
    expect(parsed.error.code).toBe("platform_unavailable");
    expect(parsed.error.origin).toBe("upstream");
    expect(typeof parsed.error.message).toBe("string");
  });

  test("falls back to a generic envelope for unknown throws", async () => {
    const { errorClientResponseBody } = await import("../../src/transport/dispatch/attempt-finalize");
    const parsed = JSON.parse(errorClientResponseBody(new Error("weird"))) as {
      error: Record<string, unknown>;
    };
    expect(parsed.error.code).toBe("internal_error");
  });
});
