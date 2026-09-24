import { describe, expect, test } from "bun:test";
import { computeTokensPerSec } from "../../src/observability/token-speed";

describe("computeTokensPerSec", () => {
  test("streaming uses the observed decode window, excluding TTFT", () => {
    // 100 output tokens decoded over 1.5s of observed streaming.
    expect(
      computeTokensPerSec({
        outputTokens: 100,
        latencyMs: 2000,
        stream: true,
        firstContentDeltaAtMs: 1000,
        lastEventAtMs: 2500,
      }),
    ).toBeCloseTo(66.67, 1);
  });

  test("non-streaming falls back to end-to-end effective speed", () => {
    // Regression: 39 completion tokens over 3.3s total used to divide by
    // ~5ms of (latency - TTFT) local overhead and report ~7800 tok/s.
    const tps = computeTokensPerSec({ outputTokens: 39, latencyMs: 3300, stream: false });
    expect(tps).toBeCloseTo(11.82, 1);
    expect(tps).toBeLessThan(100);
  });

  test("non-streaming ignores internal event timings", () => {
    // Non-streaming dispatches also observe upstream-event timestamps, but
    // those spans measure local response processing, not decode: 39 tokens
    // over a 5ms internal window must not report 7800 tok/s.
    expect(
      computeTokensPerSec({
        outputTokens: 39,
        latencyMs: 3300,
        stream: false,
        firstContentDeltaAtMs: 1789459419575,
        lastEventAtMs: 1789459419580,
      }),
    ).toBeCloseTo(11.82, 1);
  });

  test("single-chunk stream with a zero-width window falls back to effective speed", () => {
    expect(
      computeTokensPerSec({
        outputTokens: 200,
        latencyMs: 800,
        stream: true,
        firstContentDeltaAtMs: 500,
        lastEventAtMs: 500,
      }),
    ).toBeCloseTo(250, 1);
  });

  test("streaming without event timing falls back to effective speed", () => {
    expect(
      computeTokensPerSec({ outputTokens: 100, latencyMs: 2000, stream: true, firstContentDeltaAtMs: 500 }),
    ).toBeCloseTo(50, 1);
  });

  test("returns undefined without output tokens", () => {
    expect(computeTokensPerSec({ latencyMs: 2000 })).toBeUndefined();
    expect(
      computeTokensPerSec({
        outputTokens: 0,
        latencyMs: 2000,
        stream: true,
        firstContentDeltaAtMs: 1,
        lastEventAtMs: 2,
      }),
    ).toBeUndefined();
  });

  test("returns undefined without elapsed time", () => {
    expect(computeTokensPerSec({ outputTokens: 100, latencyMs: 0 })).toBeUndefined();
  });
});
