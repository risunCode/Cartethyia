import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/transport/gateway-error";
import { abortGatewayError } from "../../src/providers/operations/upstream-deadline";

describe("upstream deadline ownership", () => {
  test("preserves a gateway-owned upstream deadline as 504/upstream", () => {
    const controller = new AbortController();
    controller.abort(new GatewayError("deadline_exceeded", 504, "upstream request deadline exceeded", {}, "upstream"));

    const error = abortGatewayError(
      { signal: controller.signal, release: () => undefined },
      new DOMException("aborted", "AbortError"),
      controller.signal,
    );
    expect(error).toBeInstanceOf(GatewayError);
    expect(error?.code).toBe("deadline_exceeded");
    expect(error?.status).toBe(504);
    expect(error?.origin).toBe("upstream");
  });

  test("keeps an inbound client abort as 499/transport_closed", () => {
    const controller = new AbortController();
    controller.abort(new DOMException("client disconnected", "AbortError"));

    const error = abortGatewayError(
      { signal: controller.signal, release: () => undefined },
      new DOMException("aborted", "AbortError"),
      controller.signal,
    );

    expect(error).toBeInstanceOf(GatewayError);
    expect(error?.code).toBe("transport_closed");
    expect(error?.status).toBe(499);
  });

  test("keeps non-DOM AbortError rejections at 499", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    const result = abortGatewayError(
      { signal: new AbortController().signal, release: () => undefined },
      error,
    );

    expect(result?.code).toBe("transport_closed");
    expect(result?.status).toBe(499);
  });
});
