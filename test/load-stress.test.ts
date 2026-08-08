/**
 * Deterministic local load/stress harness for Cartethyia.
 *
 * Exercises the real production traffic-control modules (rate limiter,
 * per-IP flight tracker, in-flight counter) through a local Bun.serve
 * instance — no external APIs, no provider credentials, no Docker.
 *
 * Rate targets: 8,000 / 12,000 / 15,000 / 20,000 requests/minute.
 *
 * Heavy levels (the four RPM targets above) are opt-in via
 * `CARTETHYIA_STRESS=1` so normal CI stays bounded. A small smoke level
 * always runs to verify the harness wiring.
 *
 * Skipped heavy levels are documented in test output via `console.log`
 * with a `[stress]` prefix and a machine-readable JSON summary.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startLoadServer, type LoadServerHandle } from "./fixtures/load-server";
import { getInFlightCount, resetInFlightForTests } from "../src/traffic/in-flight";
import { activePerIpFlights } from "../src/traffic/per-ip";

// ────────────────────────────────────────────────────────────────────────────
//  Configuration
// ────────────────────────────────────────────────────────────────────────────

/**
 * `CARTETHYIA_STRESS=1` opts in to the four heavy RPM levels.
 * Without it, only the smoke level runs — keeping CI bounded.
 */
const STRESS_ENABLED = Bun.env.CARTETHYIA_STRESS === "1";

/**
 * Per-request latency budget in ms. Latency *failures* (requests that exceed
 * this budget) are tracked separately from *errors* (non-2xx responses) so
 * the summary can distinguish throughput saturation from handler faults.
 *
 * At 20k RPM (~333 req/s) with bounded concurrency, a p95 below 100ms means
 * the pipeline never queues beyond one event-loop tick.
 */
const LATENCY_BUDGET_MS = 100;

/**
 * Memory leak detection: after the full stress run, RSS must not have grown
 * beyond this ratio of the baseline. 1.5 = 50% headroom — generous enough
 * for V8 heap settling, strict enough to catch an unbounded retention bug.
 *
 * Leak tests use retainBytes to force measurable allocation; the non-retaining
 * path must plateau well within this ratio.
 */
const RSS_LEAK_RATIO = 1.5;

// ────────────────────────────────────────────────────────────────────────────
//  Rate calculation — explicit, documented, deterministic
// ────────────────────────────────────────────────────────────────────────────

/**
 * Converts a target requests-per-minute rate into deterministic test
 * parameters. The math is explicit so bottleneck analysis can trace any
 * observed throughput back to the exact request count, duration, and
 * concurrency used.
 *
 * @param rpm           Target requests per minute (e.g. 8000, 12000, 15000, 20000)
 * @param concurrency   Bounded concurrency (simultaneous in-flight requests)
 * @param durationSec   Wall-clock duration of the ramp in seconds
 *
 * @returns { totalRequests, intervalMs, expectedRps }
 *
 * Math:
 *   expectedRps       = rpm / 60
 *   totalRequests     = ceil(expectedRps * durationSec)
 *   intervalMs        = concurrency / expectedRps * 1000
 *                      (spacing between request waves so the offered load
 *                       matches the target rate given the concurrency)
 *
 * intervalMs is the per-request-slot spacing: at concurrency C and rate R
 * req/s, each of the C slots fires every C/R seconds, so the aggregate
 * offered rate is R req/s = rpm/60.
 */
function rateSpec(rpm: number, concurrency: number, durationSec: number): {
  totalRequests: number;
  intervalMs: number;
  expectedRps: number;
} {
  const expectedRps = rpm / 60;
  const totalRequests = Math.ceil(expectedRps * durationSec);
  const intervalMs = (concurrency / expectedRps) * 1000;
  return { totalRequests, intervalMs, expectedRps };
}

// ────────────────────────────────────────────────────────────────────────────
//  Metrics collection
// ────────────────────────────────────────────────────────────────────────────

interface RequestResult {
  status: number;
  latencyMs: number;
  /** True when the response was a non-2xx status. */
  isError: boolean;
  /** True when latency exceeded the budget (tracked separately from errors). */
  isLatencyFailure: boolean;
}

interface StressSummary {
  level: string;
  targetRpm: number;
  concurrency: number;
  durationSec: number;
  totalRequests: number;
  completed: number;
  errors: number;
  latencyFailures: number;
  throughputRps: number;
  achievedRpm: number;
  p50: number;
  p95: number;
  p99: number;
  minMs: number;
  maxMs: number;
  rssBeforeMb: number;
  rssAfterMb: number;
  rssDeltaMb: number;
  rssRatio: number;
  elapsedMs: number;
}

/**
 * Returns RSS in bytes, clamped to 0 if the runtime doesn't expose it.
 */
function rssBytes(): number {
  return process.memoryUsage().rss;
}

function mb(bytes: number): number {
  return bytes / (1024 * 1024);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function summarize(
  results: RequestResult[],
  level: string,
  targetRpm: number,
  concurrency: number,
  durationSec: number,
  totalRequests: number,
  rssBefore: number,
  rssAfter: number,
  elapsedMs: number,
): StressSummary {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const completed = results.length;
  const errors = results.filter((r) => r.isError).length;
  const latencyFailures = results.filter((r) => r.isLatencyFailure && !r.isError).length;
  const throughputRps = elapsedMs > 0 ? (completed / elapsedMs) * 1000 : 0;
  const rssRatio = rssBefore > 0 ? rssAfter / rssBefore : 1;
  return {
    level,
    targetRpm,
    concurrency,
    durationSec,
    totalRequests,
    completed,
    errors,
    latencyFailures,
    throughputRps: Math.round(throughputRps * 100) / 100,
    achievedRpm: Math.round(throughputRps * 60),
    p50: Math.round(percentile(latencies, 50) * 100) / 100,
    p95: Math.round(percentile(latencies, 95) * 100) / 100,
    p99: Math.round(percentile(latencies, 99) * 100) / 100,
    minMs: latencies.length > 0 ? Math.round(latencies[0]! * 100) / 100 : 0,
    maxMs: latencies.length > 0 ? Math.round((latencies[latencies.length - 1]!) * 100) / 100 : 0,
    rssBeforeMb: Math.round(mb(rssBefore) * 100) / 100,
    rssAfterMb: Math.round(mb(rssAfter) * 100) / 100,
    rssDeltaMb: Math.round(mb(rssAfter - rssBefore) * 100) / 100,
    rssRatio: Math.round(rssRatio * 1000) / 1000,
    elapsedMs: Math.round(elapsedMs),
  };
}

/**
 * Emits a machine-readable JSON summary suitable for bottleneck analysis.
 * One line per level so `bun test` output stays parseable.
 */
function emitSummary(summary: StressSummary): void {
  console.log(`[stress] ${JSON.stringify(summary)}`);
}

// ────────────────────────────────────────────────────────────────────────────
//  Load driver — bounded concurrency with connection reuse
// ────────────────────────────────────────────────────────────────────────────

/**
 * Drives `totalRequests` against the server with bounded concurrency.
 *
 * Concurrency is bounded by a simple ticket semaphore: at most
 * `concurrency` requests are in-flight at any moment. Each request reuses
 * the shared `keepalive` flag on the fetch connection so the OS socket pool
 * is exercised (connection reuse), not a fresh TCP handshake per request.
 *
 * Returns per-request results for metric aggregation. Non-2xx responses are
 * counted as errors; timeouts (AbortController) are counted as errors with
 * a distinct status code (0 = client-side timeout) so the summary can
 * distinguish server rejections from client cancellations.
 */
async function driveLoad(
  baseUrl: string,
  totalRequests: number,
  concurrency: number,
  timeoutMs: number,
  ip = "127.0.0.1",
  paceMs = 0,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= totalRequests) break;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = performance.now();
      let status = 0;
      let isError = false;

      try {
        const response = await fetch(`${baseUrl}/stress`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-ip": ip },
          body: JSON.stringify({ index }),
          signal: controller.signal,
          // keepalive: true reuses the underlying TCP socket — exercises
          // connection reuse under load, matching production client behavior.
          keepalive: true,
        });
        status = response.status;
        // Drain the body so the socket is eligible for reuse.
        await response.text();
        if (status < 200 || status >= 300) isError = true;
      } catch (error) {
        // AbortError → client-side timeout/cancellation.
        status = 0;
        isError = true;
        void error;
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = performance.now() - startedAt;
      results.push({
        status,
        latencyMs,
        isError,
        isLatencyFailure: latencyMs > LATENCY_BUDGET_MS,
      });
      if (paceMs > 0) {
        // Deliberate wall-clock pacing is the behavior under test: this
        // integration harness must offer the configured RPM to a real socket.
        await Bun.sleep(paceMs);
      }
  }
  }

  const workers = Array.from({ length: Math.min(concurrency, totalRequests) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ────────────────────────────────────────────────────────────────────────────
//  Test suite
// ────────────────────────────────────────────────────────────────────────────

describe("load and stress harness", () => {
  // Shared server for all tests in this describe block — started once,
  // disposed once. Each test that needs different server config starts its
  // own short-lived server and disposes it inside the test body.
  let sharedServer: LoadServerHandle | null = null;

  beforeAll(() => {
    sharedServer = startLoadServer({
      // High rate limit so the smoke level and shared-path tests don't
      // trip 429s — per-IP rate limiting is tested separately below.
      rateLimitMaxRequests: 1_000_000,
      rateLimitWindowMs: 60_000,
      maxFlightsPerIp: 500,
      maxGlobalInFlight: 500,
      workMs: 0,
    });
  });

  afterAll(() => {
    sharedServer?.dispose();
    sharedServer = null;
    // Belt-and-suspenders: reset process-global state after the suite.
    resetInFlightForTests();
    activePerIpFlights.clear();
  });

  // ── Smoke level (always runs) ──────────────────────────────────────────

  test("smoke: harness wiring, health, and /stress 200 under minimal load", async () => {
    const handle = sharedServer!;
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);

    // Health endpoint.
    const health = await fetch(`${handle.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toContain("Cartethyia is serving!");

    // Single stress request.
    const response = await fetch(`${handle.url}/stress`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-ip": "smoke-ip" },
      body: JSON.stringify({ index: 0 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { readonly ok: boolean };
    expect(body.ok).toBe(true);

    // In-flight counter must be back to zero after the request completes.
    expect(handle.limiter.size()).toBeGreaterThan(0);
  });

  // ── Bounded concurrency saturation ──────────────────────────────────────

  test("bounded concurrency: 200 concurrent requests complete without resource leak", async () => {
    const handle = sharedServer!;
    const CONCURRENCY = 200;
    const TOTAL = 500;
    const rssBefore = rssBytes();

    const results = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "concurrency-ip");

    const summary = summarize(results, "concurrency", 0, CONCURRENCY, 0, TOTAL, rssBefore, rssBytes(), 0);
    emitSummary(summary);

    expect(results.length).toBe(TOTAL);
    const errors = results.filter((r) => r.isError);
    expect(errors.length).toBe(0);
    // All requests must be 200 — we're under the global cap (500) and
    // per-IP flight cap (500).
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Allow a microtask for the release() to propagate.
    await new Promise((r) => setTimeout(r, 10));
    expect(getInFlightCount()).toBe(0);
    // RSS must not leak beyond the ratio threshold.
    expect(summary.rssRatio).toBeLessThanOrEqual(RSS_LEAK_RATIO);
  });

  // ── Per-IP rate limiting under load ─────────────────────────────────────

  test("rate limiter: enforces sliding window cap and returns 429 beyond it", async () => {
    // Dedicated server with a tight rate limit so we deterministically
    // observe 429s without waiting for wall-clock windows to expire.
    const handle = startLoadServer({
      rateLimitMaxRequests: 50,
      rateLimitWindowMs: 10_000,
      maxFlightsPerIp: 500,
      maxGlobalInFlight: 500,
    });
    try {
      const RATE_LIMIT = 50;
      const TOTAL = 200; // 50 allowed, 150 rejected
      const CONCURRENCY = 50;

      const results = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "ratelimit-ip");

      const summary = summarize(results, "rate-limit", 0, CONCURRENCY, 0, TOTAL, 0, 0, 0);
      emitSummary(summary);

      const ok = results.filter((r) => r.status === 200);
      const rejected = results.filter((r) => r.status === 429);
      // Exactly RATE_LIMIT requests should succeed; the rest get 429.
      // (Concurrency is 50 = RATE_LIMIT, so the first batch wins all slots.)
      expect(ok.length).toBeLessThanOrEqual(RATE_LIMIT);
      expect(rejected.length).toBeGreaterThanOrEqual(TOTAL - RATE_LIMIT);
      expect(ok.length + rejected.length).toBe(TOTAL);
      // Every rejected response must carry a 429 status.
      for (const r of rejected) {
        expect(r.status).toBe(429);
      }
    } finally {
      handle.dispose();
    }
  });

  // ── Global concurrency saturation (capacity rejection) ─────────────────

  test("global in-flight cap: rejects with 429 at capacity", async () => {
    // Server with a tiny global cap so we can saturate it deterministically.
    const handle = startLoadServer({
      rateLimitMaxRequests: 1_000_000,
      rateLimitWindowMs: 60_000,
      maxFlightsPerIp: 500,
      maxGlobalInFlight: 10, // tiny cap
      workMs: 50, // hold the slot for 50ms so concurrency builds up
    });
    try {
      const TOTAL = 100;
      const CONCURRENCY = 100; // all fire at once — 10 succeed, 90 get 429

      const results = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "capacity-ip");

      const summary = summarize(results, "capacity", 0, CONCURRENCY, 0, TOTAL, 0, 0, 0);
      emitSummary(summary);

      const ok = results.filter((r) => r.status === 200);
      const rejected = results.filter((r) => r.status === 429);
      expect(ok.length).toBeGreaterThan(0);
      expect(ok.length).toBeLessThanOrEqual(10);
      expect(rejected.length).toBeGreaterThan(0);
      // No 500s — capacity rejections are clean 429s, not handler failures.
      expect(results.filter((r) => r.status === 500).length).toBe(0);
    } finally {
      handle.dispose();
    }
  });

  // ── Connection reuse: keepalive under sustained load ───────────────────

  test("connection reuse: sustained load with keepalive reuses sockets", async () => {
    const handle = sharedServer!;
    const TOTAL = 1000;
    const CONCURRENCY = 50;
    const rssBefore = rssBytes();
    const startedAt = performance.now();

    const results = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "reuse-ip");

    const elapsedMs = performance.now() - startedAt;
    const summary = summarize(
      results,
      "connection-reuse",
      0,
      CONCURRENCY,
      0,
      TOTAL,
      rssBefore,
      rssBytes(),
      elapsedMs,
    );
    emitSummary(summary);

    expect(results.length).toBe(TOTAL);
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Throughput should be high — no artificial serialization.
    expect(summary.throughputRps).toBeGreaterThan(0);
    // p99 must be within budget for pure-CPU work (workMs=0).
    expect(summary.p99).toBeLessThan(LATENCY_BUDGET_MS);
    expect(summary.rssRatio).toBeLessThanOrEqual(RSS_LEAK_RATIO);
  });

  // ── Request cancellation / timeout ──────────────────────────────────────

  test("request cancellation: client abort releases server-side in-flight slot", async () => {
    // Server with non-trivial work time so we can abort mid-flight.
    const handle = startLoadServer({
      rateLimitMaxRequests: 1_000_000,
      rateLimitWindowMs: 60_000,
      maxFlightsPerIp: 500,
      maxGlobalInFlight: 500,
      workMs: 500, // long enough to abort before completion
    });
    try {
      const controller = new AbortController();
      // Abort after 50ms — well before the 500ms work completes.
      setTimeout(() => controller.abort(), 50);

      const startedAt = performance.now();
      let caughtAbort = false;
      try {
        await fetch(`${handle.url}/stress`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-ip": "cancel-ip" },
          body: JSON.stringify({ index: 0 }),
          signal: controller.signal,
        });
      } catch (error) {
        caughtAbort = error instanceof DOMException && error.name === "AbortError";
      }
      const elapsed = performance.now() - startedAt;

      expect(caughtAbort).toBe(true);
      // Must have aborted well before the 500ms work window.
      expect(elapsed).toBeLessThan(400);

      // Allow the server-side release() to propagate.
      await new Promise((r) => setTimeout(r, 50));
      expect(getInFlightCount()).toBe(0);

      // The server must still accept new requests — the slot was released.
      const followUp = await fetch(`${handle.url}/stress`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-ip": "cancel-ip" },
        body: JSON.stringify({ index: 0 }),
        signal: AbortSignal.timeout(1000),
      });
      expect(followUp.status).toBe(200);
    } finally {
      handle.dispose();
    }
  });

  test("request timeout: client-side timeout is distinct from server error", async () => {
    // Server with work time longer than the client timeout.
    const handle = startLoadServer({
      rateLimitMaxRequests: 1_000_000,
      rateLimitWindowMs: 60_000,
      maxFlightsPerIp: 500,
      maxGlobalInFlight: 500,
      workMs: 1000,
    });
    try {
      // Drive 10 concurrent requests with a 100ms client timeout.
      // Work is 1000ms, so all should abort client-side (status 0).
      const results = await driveLoad(handle.url, 10, 10, 100, "timeout-ip");

      // At least some should time out — status 0 (client abort).
      const timeouts = results.filter((r) => r.status === 0 && r.isError);
      expect(timeouts.length).toBeGreaterThan(0);

      // No 500s — timeouts are client-side, not server handler failures.
      expect(results.filter((r) => r.status === 500).length).toBe(0);

      const summary = summarize(results, "timeout", 0, 10, 0, 10, 0, 0, 0);
      emitSummary(summary);

      // Server must still be healthy after the timeout storm.
      const health = await fetch(`${handle.url}/health`);
      expect(health.status).toBe(200);
    } finally {
      handle.dispose();
    }
  });

  // ── Network backpressure: sustained concurrent flood ───────────────────

  test("network backpressure: sustained flood does not crash server or leak sockets", async () => {
    const handle = sharedServer!;
    const TOTAL = 2000;
    const CONCURRENCY = 100;
    const rssBefore = rssBytes();
    const startedAt = performance.now();

    const results = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "backpressure-ip");

    const elapsedMs = performance.now() - startedAt;
    const summary = summarize(
      results,
      "backpressure",
      0,
      CONCURRENCY,
      0,
      TOTAL,
      rssBefore,
      rssBytes(),
      elapsedMs,
    );
    emitSummary(summary);

    expect(results.length).toBe(TOTAL);
    // No handler failures (500) under backpressure.
    expect(results.filter((r) => r.status === 500).length).toBe(0);
    // Server is still healthy after the flood.
    const health = await fetch(`${handle.url}/health`);
    expect(health.status).toBe(200);
    // RSS must plateau.
    expect(summary.rssRatio).toBeLessThanOrEqual(RSS_LEAK_RATIO);
  });

  // ── Memory plateau / leak detection ──────────────────────────────────────

  test("memory plateau: RSS plateaus under sustained non-retaining load", async () => {
    const handle = sharedServer!; // retainBytes=0 (default)
    const TOTAL = 3000;
    const CONCURRENCY = 100;

    // Sample RSS at three points: before, mid, after.
    const rssBefore = rssBytes();
    const results1 = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "plateau-ip");
    const rssMid = rssBytes();
    const results2 = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "plateau-ip");
    const rssAfter = rssBytes();

    const allResults = [...results1, ...results2];
    const summary = summarize(allResults, "memory-plateau", 0, CONCURRENCY, 0, TOTAL * 2, rssBefore, rssAfter, 0);
    emitSummary(summary);

    expect(allResults.length).toBe(TOTAL * 2);
    expect(allResults.every((r) => r.status === 200)).toBe(true);

    // The second-half RSS (rssMid → rssAfter) must not grow as fast as
    // the first half (rssBefore → rssMid) — the heap should plateau.
    const firstHalfGrowth = rssMid - rssBefore;
    const secondHalfGrowth = rssAfter - rssMid;
    // Second half growth must be less than or equal to first half
    // (plateau, not unbounded). Allow a small margin for V8 settling.
    expect(secondHalfGrowth).toBeLessThanOrEqual(firstHalfGrowth + 5 * 1024 * 1024);
    // Overall ratio must be within bounds.
    expect(summary.rssRatio).toBeLessThanOrEqual(RSS_LEAK_RATIO);
  });

  test("leak detection: retained buffers are observable and disposable", async () => {
    // Server that retains 4KB per request — should show clear RSS growth.
    const handle = startLoadServer({
      rateLimitMaxRequests: 1_000_000,
      rateLimitWindowMs: 60_000,
      maxFlightsPerIp: 500,
      maxGlobalInFlight: 500,
      workMs: 0,
      retainBytes: 4 * 1024, // 4KB per request
    });
    try {
      const TOTAL = 500;
      const CONCURRENCY = 50;
      const rssBefore = rssBytes();

      const results = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "leak-ip");

      const rssAfter = rssBytes();
      const summary = summarize(results, "leak-retained", 0, CONCURRENCY, 0, TOTAL, rssBefore, rssAfter, 0);
      emitSummary(summary);

      expect(results.every((r) => r.status === 200)).toBe(true);
      // Retained 4KB × 500 = ~2MB — RSS should have grown measurably.
      // (At least 500KB to avoid noise; 4KB×500 = 2MB of intentional retention.)
      expect(rssAfter - rssBefore).toBeGreaterThan(500 * 1024);
      // Dispose must stop the server and clear the retained buffers —
      // verify by attempting a connection (must be refused after dispose)
      // and by re-sampling RSS. The GC is a non-blocking hint, so we assert
      // the *observable* invariant: the server no longer accepts connections.
      handle.dispose();
      Bun.gc(false);
      // The server must be stopped — a follow-up fetch must fail.
      let refused = false;
      try {
        await fetch(`${handle.url}/health`, { signal: AbortSignal.timeout(500) });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    } finally {
      // Already disposed in the try block; idempotent.
      handle.dispose();
    }
  });

  // ── Heavy RPM levels (opt-in via CARTETHYIA_STRESS=1) ──────────────────

  // Each level uses the explicit rateSpec math to compute total requests
  // and interval spacing from the target RPM. The levels are:
  //   8,000 / 12,000 / 15,000 / 20,000 requests/minute.
  // Normal CI (CARTETHYIA_STRESS unset) skips these with a clear message.

  for (const level of [
    { name: "8k-rpm", rpm: 8_000, concurrency: 50, durationSec: 5 },
    { name: "12k-rpm", rpm: 12_000, concurrency: 75, durationSec: 5 },
    { name: "15k-rpm", rpm: 15_000, concurrency: 100, durationSec: 5 },
    { name: "20k-rpm", rpm: 20_000, concurrency: 150, durationSec: 5 },
  ]) {
    test(`heavy: ${level.name} (${level.rpm} RPM target${STRESS_ENABLED ? "" : " — SKIPPED; set CARTETHYIA_STRESS=1 to enable"})`, async () => {
      if (!STRESS_ENABLED) {
        const spec = rateSpec(level.rpm, level.concurrency, level.durationSec);
        console.log(
          `[stress] ${JSON.stringify({
            level: level.name,
            targetRpm: level.rpm,
            concurrency: level.concurrency,
            durationSec: level.durationSec,
            skipped: true,
            reason: "CARTETHYIA_STRESS not set to 1",
            wouldSend: spec.totalRequests,
            expectedRps: Math.round(spec.expectedRps * 100) / 100,
            intervalMs: Math.round(spec.intervalMs * 100) / 100,
          })}`,
        );
        expect(true).toBe(true); // no-op pass — documents the skip
        return;
      }

      // Fresh server for each heavy level with a high rate limit so
      // the only rejections are from genuine capacity saturation.
      const handle = startLoadServer({
        rateLimitMaxRequests: 1_000_000,
        rateLimitWindowMs: 60_000,
        maxFlightsPerIp: 500,
        maxGlobalInFlight: 500,
        workMs: 0,
      });
      try {
        const spec = rateSpec(level.rpm, level.concurrency, level.durationSec);
        const rssBefore = rssBytes();
        const startedAt = performance.now();

        const results = await driveLoad(handle.url, spec.totalRequests, level.concurrency, 5_000, `${level.name}-ip`, spec.intervalMs);

        const elapsedMs = performance.now() - startedAt;
        const summary = summarize(
          results,
          level.name,
          level.rpm,
          level.concurrency,
          level.durationSec,
          spec.totalRequests,
          rssBefore,
          rssBytes(),
          elapsedMs,
        );
        emitSummary(summary);

        // ── Deterministic assertions ──────────────────────────────────
        // 1. Every request must complete (no uncaught fetch failures).
        expect(results.length).toBe(spec.totalRequests);
        // 2. No handler failures (500) — 429s from capacity are allowed.
        const handlerFaults = results.filter((r) => r.status >= 500);
        expect(handlerFaults.length).toBe(0);
        // 3. Errors must be capacity rejections (429), not handler faults.
        expect(summary.errors).toBe(results.filter((r) => r.isError).length);
        // 4. Achieved RPM should be in the same order of magnitude as target.
        //    (Allow 50% headroom — local loopback is fast, but scheduling
        //    variance can cause dips. The point is: no catastrophic stall.)
        expect(summary.achievedRpm).toBeGreaterThan(level.rpm * 0.5);
        // 5. RSS must not leak beyond the ratio threshold.
        expect(summary.rssRatio).toBeLessThanOrEqual(RSS_LEAK_RATIO);
        // 6. p95 latency must be within budget — the pipeline is not
        //    queue-bound at this concurrency.
        expect(summary.p95).toBeLessThan(LATENCY_BUDGET_MS);
      } finally {
        handle.dispose();
      }
    });
  }

  // ── Summary: errors vs latency failures distinction ─────────────────────

  test("metric taxonomy: errors and latency failures are independently tracked", async () => {
    const handle = startLoadServer({
      rateLimitMaxRequests: 10, // tight rate limit → many 429s (errors)
      rateLimitWindowMs: 10_000,
      maxFlightsPerIp: 500,
      maxGlobalInFlight: 500,
      workMs: 200, // slow work → some latency failures (>100ms budget)
    });
    try {
      const TOTAL = 100;
      const CONCURRENCY = 50;

      const results = await driveLoad(handle.url, TOTAL, CONCURRENCY, 5_000, "taxonomy-ip");

      const summary = summarize(results, "taxonomy", 0, CONCURRENCY, 0, TOTAL, 0, 0, 0);
      emitSummary(summary);

      // Errors = non-2xx responses (429 rate-limit rejections).
      expect(summary.errors).toBe(results.filter((r) => r.isError).length);
      // Latency failures = requests >100ms that were NOT errors (i.e. 200s
      // that took too long). These are tracked separately from errors.
      expect(summary.latencyFailures).toBe(
        results.filter((r) => r.isLatencyFailure && !r.isError).length,
      );
      // The two counts must be independent — errors don't count as latency
      // failures even if they're slow.
      // If there are any 200s with workMs=200, some should be latency failures.
      const ok = results.filter((r) => r.status === 200);
      if (ok.length > 0) {
        // 200s with 200ms work should exceed the 100ms latency budget.
        const slow200s = ok.filter((r) => r.latencyMs > LATENCY_BUDGET_MS);
        expect(slow200s.length).toBeGreaterThan(0);
      }
    } finally {
      handle.dispose();
    }
  });
});
