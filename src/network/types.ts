/**
 * Proxy pool config types.
 *
 * A pool row stores its transport config in `network_pools.endpoint_config`
 * (jsonb) — there is no config directory as the source of truth. HTTP(S) and
 * SOCKS5 pools carry no credential material beyond the endpoint itself, so
 * `credential_ciphertext` exists only for compatibility with rows written
 * before the binary-backed transports were removed.
 *
 * Strict `parse*` validators sit at the trust boundary between the DB/console
 * and the agent resolver, so a malformed row fails loudly instead of producing
 * a silently-wrong agent.
 */
import { isRecord } from "../protocol/primitives";

/** Thrown when a stored/requested pool config cannot be decoded. */
export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyConfigError";
  }
}

/** Connection-pool tuning applied to each pool agent. */
export interface AgentConfig {
  readonly maxSockets?: number;
  readonly maxFreeSockets?: number;
  readonly keepAliveTimeout?: number;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new ProxyConfigError(`${field} must be an integer between ${min} and ${max}`);
  return parsed;
}

/** Validates optional per-pool agent tuning stored alongside the transport config. */
export function parseAgentConfig(value: unknown): AgentConfig {
  if (!isRecord(value)) return {};
  const maxSockets = optionalInteger(value.maxSockets, "maxSockets", 1, 100_000);
  const maxFreeSockets = optionalInteger(value.maxFreeSockets, "maxFreeSockets", 0, 100_000);
  const keepAliveTimeout = optionalInteger(value.keepAliveTimeout, "keepAliveTimeout", 0, 3_600_000);
  return {
    ...(maxSockets === undefined ? {} : { maxSockets }),
    ...(maxFreeSockets === undefined ? {} : { maxFreeSockets }),
    ...(keepAliveTimeout === undefined ? {} : { keepAliveTimeout }),
  };
}
