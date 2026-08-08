/**
 * Local stress harness HTTP server fixture.
 *
 * Spins up a real Bun.serve instance that exercises the *actual* production
 * traffic-control modules — SlidingWindowRateLimiter, PerIpFlightTracker,
 * and the process-wide in-flight counter — so the stress test measures real
 * code paths, not a mock. No external APIs, no provider credentials, no
 * Docker — just local loopback.
 *
 * The server mirrors the src/middleware/server.ts request lifecycle:
 *   rate-limit check → per-IP flight acquire → in-flight increment →
 *   bounded work → in-flight decrement → flight release.
 *
 * Response shapes intentionally match the production error envelope so
 * stress tests can distinguish capacity rejections (429) from handler
 * failures (500) from latency budget misses.
 */

import { SlidingWindowRateLimiter } from "../../src/traffic/rate-limiter";
import { activePerIpFlights, type PerIpFlightHandle } from "../../src/traffic/per-ip";
import { getInFlightCount, incrementInFlight, decrementInFlight, resetInFlightForTests } from "../../src/traffic/in-flight";
import { runtimeMemoryLimits } from "../../src/traffic/limits";

export interface LoadServerOptions {
  /** Port to listen on. 0 = ephemeral (OS-assigned). */
  readonly port?: number;
  /** Max requests per IP per rate-limit window. */
  readonly rateLimitMaxRequests?: number;
  /** Rate-limit window length in ms. */
  readonly rateLimitWindowMs?: number;
  /** Max concurrent in-flight requests per IP. */
  readonly maxFlightsPerIp?: number;
  /** Hard cap on concurrent in-flight requests globally. */
  readonly maxGlobalInFlight?: number;
  /** Simulated handler work time in ms (setTimeout delay). 0 = pure CPU. */
  readonly workMs?: number;
  /**
   * When >0, the /stress endpoint writes a per-request buffer into a
   * per-request array that is never read, simulating backpressure-induced
   * retention. The buffer is sized so leak detection can observe RSS growth.
   */
  readonly retainBytes?: number;
}

export interface LoadServerHandle {
  /** Base URL including the OS-assigned port (e.g. http://127.0.0.1:39121). */
  readonly url: string;
  /** The underlying Bun server — call .stop() (also in dispose()). */
  readonly server: Bun.Server<unknown>;
  /** Rate limiter instance — exposed for state assertions. */
  readonly limiter: SlidingWindowRateLimiter;
  /** Per-IP flight tracker (the shared process-global). */
  readonly flights: typeof activePerIpFlights;
  /** Fully release all resources. Idempotent. */
  dispose(): void;
}

/**
 * Starts a local stress-server. Always returns a handle whose dispose()
 * stops the server and resets the shared in-flight counter — callers MUST
 * dispose in a finally/cleanup stack.
 */
export function startLoadServer(options: LoadServerOptions = {}): LoadServerHandle {
  // Fresh state — reset the process-global in-flight counter and per-IP
  // tracker so parallel tests don't contaminate each other.
  resetInFlightForTests();
  activePerIpFlights.clear();

  const rateLimitMaxRequests = options.rateLimitMaxRequests ?? runtimeMemoryLimits.rateLimitMaxRequests;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? runtimeMemoryLimits.rateLimitWindowMs;
  const maxFlightsPerIp = options.maxFlightsPerIp ?? 50;
  const maxGlobalInFlight = options.maxGlobalInFlight ?? 500;
  const workMs = options.workMs ?? 0;
  const retainBytes = options.retainBytes ?? 0;

  const limiter = new SlidingWindowRateLimiter(rateLimitMaxRequests, rateLimitWindowMs);
  const flights = activePerIpFlights;

  // Per-request retention sink for leak detection. Closed via dispose().
  const retained: Uint8Array[] = [];
  const publicV1HealthBody = [
    "Cartethyia is serving!",
    "          .     .",
    "       .  /|\\ . /|\\  .",
    "        \\-***-/-***-/",
    "       .-'  .---.  '-.",
    "      /    / o o \\    \\",
    "     ;    |   ^   |    ;",
    "     |     \\ '-' /     |",
    "     ;      '---'      ;",
    "      \\    CARTETHYIA /",
    "       '.           .'",
    "         '-._____.-'",
    "          IS SERVING",
    "",
    "Endpoints:",
    "POST /v1/chat/completions",
    "POST /v1/responses",
    "POST /v1/messages",
    "POST /v1/images/generations",
    "POST /v1/images/edits",
    "GET /v1/models",
  ].join("\n");

  const server: Bun.Server<unknown> = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // Health endpoint — no auth, no rate limit, no in-flight accounting.
      if (url.pathname === "/health" && request.method === "GET") {
        return new Response(`${publicV1HealthBody}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      // Stress endpoint — exercises the full traffic-control pipeline.
      if (url.pathname === "/stress" && request.method === "POST") {
        const ip = request.headers.get("x-test-ip") ?? "127.0.0.1";

        // 1. Rate limit (per-IP sliding window).
        const rate = limiter.tryAcquire(ip);
        if (!rate.allowed) {
          return new Response(
            JSON.stringify({ error: { code: "rate_limit_error", message: "Rate limit exceeded" } }),
            { status: 429, headers: { "content-type": "application/json", "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } },
          );
        }

        // 2. Per-IP flight acquire (bounded concurrency).
        const flight: PerIpFlightHandle | null = flights.tryAcquire(ip, maxFlightsPerIp);
        if (flight === null) {
          return new Response(
            JSON.stringify({ error: { code: "rate_limit_error", message: "Too many concurrent requests" } }),
            { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } },
          );
        }

        // 3. Global in-flight guard — reject when at capacity.
        if (getInFlightCount() >= maxGlobalInFlight) {
          flight.release();
          return new Response(
            JSON.stringify({ error: { code: "rate_limit_error", message: "Server at capacity" } }),
            { status: 429, headers: { "content-type": "application/json", "retry-after": "5" } },
          );
        }

        incrementInFlight();
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          decrementInFlight();
          flight.release();
        };

        try {
          // Honor client abort (cancellation/timeout simulation).
          if (request.signal.aborted) {
            release();
            return new Response(JSON.stringify({ error: { code: "client_abort", message: "Client aborted" } }), {
              status: 499,
              headers: { "content-type": "application/json" },
            });
          }

          // Simulated work: either pure CPU (workMs=0) or a timed delay.
          if (workMs > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, workMs);
              request.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
              });
            });
          }

          // Optional retention for leak-detection tests.
          if (retainBytes > 0) {
            retained.push(new Uint8Array(retainBytes));
          }

          release();
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          release();
          if (error instanceof DOMException && error.name === "AbortError") {
            return new Response(JSON.stringify({ error: { code: "client_abort", message: "Aborted" } }), {
              status: 499,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ error: { code: "internal_error", message: "Handler failure" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  let disposed = false;
  return {
    url: server.url.href,
    server,
    limiter,
    flights,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      server.stop(true);
      resetInFlightForTests();
      activePerIpFlights.clear();
      retained.length = 0;
    },
  };
}
