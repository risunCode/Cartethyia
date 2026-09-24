import type { HealthCheckResult } from "./contracts";

/**
 * Classifies probe responses without confusing an HTTP proxy response with a
 * failed tunnel. 402 and 407 prove the proxy answered, but make it unusable.
 */
export function classifyPoolProbeResponse(
  poolId: string,
  response: Pick<Response, "ok" | "status">,
  latencyMs: number,
): HealthCheckResult {
  if (response.status === 402 || response.status === 407) {
    const reason =
      response.status === 402 ? "Payment Required" : "Proxy Authentication Required";
    return {
      poolId,
      status: "reachable",
      httpStatus: response.status,
      latencyMs,
      errorMessage: `Proxy reachable — HTTP ${response.status} ${reason}`,
    };
  }

  return {
    poolId,
    status: "healthy",
    latencyMs,
    ...(response.ok ? {} : { errorMessage: `HTTP ${response.status} (reachable)` }),
  };
}

/** Reads the explicit status from a failed HTTP-proxy CONNECT handshake. */
export function classifyPoolConnectError(
  poolId: string,
  error: unknown,
  latencyMs: number,
): HealthCheckResult | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /^Proxy CONNECT failed: (402|407)\b/.exec(error.message);
  if (!match) return undefined;
  const status = match[1] === "402" ? 402 : 407;
  return classifyPoolProbeResponse(poolId, { ok: false, status }, latencyMs);
}
