/**
 * Operator drain endpoint: `POST /admin/drain` asks a running gateway to shut
 * down gracefully.
 *
 * Why an endpoint exists at all. On Linux the process handles `SIGTERM`/
 * `SIGINT` (see `main.ts`), which is how a container stop or an in-place image
 * swap drains in-flight requests. Windows has no deliverable catchable signal:
 * `process.kill(pid, "SIGTERM")` — and MSYS `kill` — terminate a Bun process
 * *without* running its JS handler (measured), so a Windows-hosted gateway can
 * only be stopped by a hard kill that truncates every in-flight response. This
 * route gives a scriptable graceful stop there, and a second, signal-free path
 * everywhere else.
 *
 * It is off unless `CARTETHYIA_DRAIN_TOKEN` is set, and gated twice:
 * the request must come from loopback, and it must carry the token compared in
 * constant time. The peer check is independent of the secret, so a leaked token
 * alone cannot stop a remote gateway. The drain runs after the 202 is flushed,
 * so the caller gets an acknowledgement rather than a dropped connection.
 */
import { timingSafeEqual } from "node:crypto";
import { GatewayError } from "./gateway-error";

export interface DrainEndpointDeps {
  /** Shared secret; the route is registered only when this is set. */
  readonly token: string;
  /** Begins the graceful drain (the process's own shutdown path). */
  readonly triggerDrain: () => void;
  /** Peer address of the request, resolved by the composition root. */
  readonly resolvePeerAddress: (request: Request) => string | null;
}

/**
 * Whether the peer is loopback. Accepts the IPv4-mapped IPv6 spelling Bun uses
 * on Windows (`::ffff:127.0.0.1`) and the whole `127.0.0.0/8` block, so the
 * check matches however the socket reports a local caller.
 */
function isLoopbackPeer(peer: string | null): boolean {
  if (peer === null || peer.length === 0) return false;
  const normalized = peer.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return bare === "127.0.0.1" || bare.startsWith("127.");
}

/** Constant-time token comparison; length mismatch short-circuits safely. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDrainHandler(
  deps: DrainEndpointDeps,
): (context: { request: Request }) => Promise<Response> {
  return async ({ request }) => {
    if (!isLoopbackPeer(deps.resolvePeerAddress(request)))
      throw new GatewayError("invalid_request", 403, "drain is only available from loopback");
    if (!tokenMatches(request.headers.get("x-drain-token"), deps.token))
      throw new GatewayError("invalid_request", 401, "invalid drain token");
    // Acknowledge first, then drain: the response must be on the wire before the
    // shutdown path starts closing sockets, or the caller sees a dropped
    // connection instead of a 202.
    setTimeout(() => deps.triggerDrain(), 0);
    return new Response(JSON.stringify({ status: "draining" }), {
      status: 202,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
}
