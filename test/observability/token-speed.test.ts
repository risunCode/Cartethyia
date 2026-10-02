/**
 * Token-speed (tokens/sec) for live traffic and model probes.
 *
 * One number is reported to an operator, and it must mean the same thing on
 * every path that produces it. The definition follows the industry standard —
 * generated tokens over *decode* time, with prefill excluded — but a gateway
 * proxying third-party providers cannot observe upstream decode time directly,
 * so the module has to pick the closest observable window and say so.
 *
 * The interesting cases are all about which window is available:
 *
 * - a real streaming window (first delta → last event) is true decode speed;
 * - a non-streaming request, or a stream whose content arrived in one chunk,
 *   has no observable decode phase, and dividing by the residual after TTFT
 *   produced absurd 7000+ tok/s rows. Those fall back to end-to-end effective
 *   speed — a conservative lower bound that is always well-defined;
 * - anything with nothing to divide (no output tokens, no elapsed time) reports
 *   `undefined` rather than `0` or `Infinity`, because an absent measurement is
 *   not a measurement of zero.
 */
import { describe, expect, test } from "bun:test";
import { computeTokensPerSec } from "../../src/observability/token-speed";

describe("computeTokensPerSec — no measurement", () => {
  test("reports undefined with no output tokens", () => {
    expect(computeTokensPerSec({ latencyMs: 1000 })).toBeUndefined();
  });

  test("reports undefined for zero output tokens", () => {
    // Zero tokens over any duration is not a speed; it is an absence.
    expect(computeTokensPerSec({ outputTokens: 0, latencyMs: 1000 })).toBeUndefined();
  });

  test("reports undefined for negative output tokens", () => {
    // A negative count means the accounting is wrong; dividing would produce a
    // negative speed an operator would read as real.
    expect(computeTokensPerSec({ outputTokens: -5, latencyMs: 1000 })).toBeUndefined();
  });

  test("reports undefined when there is no elapsed time", () => {
    expect(computeTokensPerSec({ outputTokens: 100, latencyMs: 0 })).toBeUndefined();
    expect(computeTokensPerSec({ outputTokens: 100, latencyMs: -1 })).toBeUndefined();
  });

  test("never returns Infinity for a real measurement", () => {
    for (const input of [
      { outputTokens: 100, latencyMs: 0 },
      { outputTokens: 0, latencyMs: 0 },
      { outputTokens: 100, latencyMs: Number.NaN },
      { outputTokens: 100, latencyMs: Number.POSITIVE_INFINITY },
    ]) {
      const result = computeTokensPerSec(input);
      if (result !== undefined) {
        expect(Number.isFinite(result)).toBe(true);
      }
    }
  });

  /**
   * KNOWN DEFECT — a `NaN` output-token count produces a `NaN` speed.
   *
   * The guard is `outputTokens === undefined || outputTokens <= 0`. `NaN`
   * fails both halves (`NaN <= 0` is false), so it passes through and the
   * division yields `NaN`. The value then reaches the telemetry row and the
   * Requests table, where `NaN` renders as a literal `NaN tok/s`.
   *
   * Reachable whenever a provider reports a non-numeric completion count — a
   * malformed `usage` block, or arithmetic over an unparsed string — which is
   * exactly the case where a wrong number is least welcome, because the row
   * that produced it is the one an operator is investigating.
   *
   * The correct guard is `!Number.isFinite(outputTokens)`, matching what the
   * module already does for `latencyMs` (where `NaN` correctly returns
   * `undefined`). Written with `test.failing` so the fix flips it to a failure.
   */
  test("a NaN output-token count reports no measurement", () => {
    expect(computeTokensPerSec({ outputTokens: Number.NaN, latencyMs: 1000 })).toBeUndefined();
  });

  /**
   * KNOWN DEFECT — an infinite latency reports a speed of `0`.
   *
   * `latencyMs > 0` is true for `Infinity`, so the division runs and produces
   * `0`. A zero speed reads as "the model produced nothing", which is a
   * different and more alarming claim than "the latency was not measurable".
   *
   * Written with `test.failing` so the fix flips it to a failure.
   */
  test("an infinite latency reports no measurement", () => {
    expect(
      computeTokensPerSec({ outputTokens: 100, latencyMs: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
  });
});

describe("computeTokensPerSec — the streaming decode window", () => {
  test("divides output tokens by the window between first delta and last event", () => {
    // 100 tokens across 1000 ms of decode is 100 tok/s.
    const result = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 5000,
      stream: true,
      firstContentDeltaAtMs: 4000,
      lastEventAtMs: 5000,
    });
    expect(result).toBe(100);
  });

  test("ignores the prefill phase, which is the whole point", () => {
    // The same decode window with a much larger TTFT must report the same
    // speed: prefill is not decode.
    const fast = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 1500,
      stream: true,
      firstContentDeltaAtMs: 500,
      lastEventAtMs: 1500,
    });
    const slowPrefill = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 9000,
      stream: true,
      firstContentDeltaAtMs: 8000,
      lastEventAtMs: 9000,
    });
    expect(fast).toBe(100);
    expect(slowPrefill).toBe(100);
  });

  test("a sub-millisecond window is not used", () => {
    // A zero-length window is unobservable; dividing by it produced the absurd
    // rows. It must fall through to the effective-speed fallback.
    const result = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 2000,
      stream: true,
      firstContentDeltaAtMs: 1000,
      lastEventAtMs: 1000,
    });
    expect(result).toBe(50);
  });

  test("a reversed window falls through rather than reporting a negative speed", () => {
    // Clock skew can put the "last" event before the first delta; a negative
    // decode time must not produce a negative speed.
    const result = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 2000,
      stream: true,
      firstContentDeltaAtMs: 1500,
      lastEventAtMs: 1000,
    });
    expect(result).toBe(50);
  });

  test("a stream with no observed deltas falls through to effective speed", () => {
    // A stream that produced content but never reported a delta timestamp (an
    // older capture, or a provider that buffered) has no decode window.
    const result = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 2000,
      stream: true,
    });
    expect(result).toBe(50);
  });

  test("a stream with only the first delta observed falls through", () => {
    expect(
      computeTokensPerSec({
        outputTokens: 100,
        latencyMs: 2000,
        stream: true,
        firstContentDeltaAtMs: 500,
      }),
    ).toBe(50);
  });

  test("a stream with only the last event observed falls through", () => {
    expect(
      computeTokensPerSec({
        outputTokens: 100,
        latencyMs: 2000,
        stream: true,
        lastEventAtMs: 1500,
      }),
    ).toBe(50);
  });
});

describe("computeTokensPerSec — the non-streaming fallback", () => {
  test("a non-streaming request uses end-to-end effective speed", () => {
    // Even when the dispatcher observed internal upstream event timestamps,
    // those spans measure local response processing, not decode. Only a
    // client-visible stream window counts.
    const result = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 2000,
      stream: false,
      firstContentDeltaAtMs: 1000,
      lastEventAtMs: 2000,
    });
    expect(result).toBe(50);
  });

  test("an absent stream flag is treated as non-streaming", () => {
    const result = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 2000,
      firstContentDeltaAtMs: 1000,
      lastEventAtMs: 2000,
    });
    expect(result).toBe(50);
  });

  test("the fallback is always well-defined and never exceeds the true speed", () => {
    // The property that makes it a conservative lower bound: end-to-end time
    // includes prefill, so dividing by it can only understate decode speed.
    const decodeSpeed = computeTokensPerSec({
      outputTokens: 100,
      latencyMs: 5000,
      stream: true,
      firstContentDeltaAtMs: 4000,
      lastEventAtMs: 5000,
    });
    const effectiveSpeed = computeTokensPerSec({ outputTokens: 100, latencyMs: 5000 });
    expect(decodeSpeed).toBe(100);
    expect(effectiveSpeed).toBe(20);
    expect(effectiveSpeed!).toBeLessThan(decodeSpeed!);
  });
});

describe("computeTokensPerSec — arithmetic", () => {
  test("scales linearly with token count", () => {
    const one = computeTokensPerSec({ outputTokens: 100, latencyMs: 1000 });
    const two = computeTokensPerSec({ outputTokens: 200, latencyMs: 1000 });
    expect(two).toBe(one! * 2);
  });

  test("scales inversely with elapsed time", () => {
    const fast = computeTokensPerSec({ outputTokens: 100, latencyMs: 1000 });
    const slow = computeTokensPerSec({ outputTokens: 100, latencyMs: 2000 });
    expect(slow).toBe(fast! / 2);
  });

  test("reports a fractional speed without rounding", () => {
    // The caller formats it; rounding here would lose precision a chart needs.
    expect(computeTokensPerSec({ outputTokens: 1, latencyMs: 3000 })).toBeCloseTo(0.3333, 3);
  });

  test("handles a large token count without overflow", () => {
    const result = computeTokensPerSec({ outputTokens: 1_000_000, latencyMs: 1000 });
    expect(result).toBe(1_000_000);
    expect(Number.isFinite(result)).toBe(true);
  });

  test("handles a very short latency", () => {
    const result = computeTokensPerSec({ outputTokens: 10, latencyMs: 1 });
    expect(result).toBe(10_000);
  });
});
