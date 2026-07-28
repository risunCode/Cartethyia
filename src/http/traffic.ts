/**
 * Client identity and in-flight request accounting. IP is the enforcement key;
 * the short fingerprint is observability-only and never contains raw client
 * headers in logs. Forwarded IP headers are ignored unless the deployment
 * explicitly trusts its reverse proxy.
 */

export interface ClientIdentity {
  ip: string;
  fingerprint: string;
  client: string;
}

export interface FlightPermit {
  ip: string;
  active: number;
}

export interface FlightRejection {
  active: number;
  limit: number;
}

function normalizeIp(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withoutPort = trimmed.startsWith("[") ? trimmed.slice(1, trimmed.indexOf("]")) : trimmed;
  const normalized = withoutPort.startsWith("::ffff:") ? withoutPort.slice(7) : withoutPort;
  return normalized || undefined;
}

function forwardedIp(headers: Headers): string | undefined {
  return normalizeIp(headers.get("cf-connecting-ip") ?? headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0] ?? "");
}

function hashFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clientLabel(headers: Headers): string {
  return headers.get("x-stainless-lang")
    ?? headers.get("x-client-name")
    ?? headers.get("user-agent")?.split(" ")[0]
    ?? "unknown";
}

/** Resolves a privacy-safe identity from trusted transport metadata and client headers. */
export function identifyClient(headers: Headers, directIp: string | undefined, trustProxy: boolean): ClientIdentity {
  const ip = trustProxy ? forwardedIp(headers) ?? normalizeIp(directIp ?? "") ?? "unknown" : normalizeIp(directIp ?? "") ?? "unknown";
  const client = clientLabel(headers);
  const fingerprintInput = [
    headers.get("user-agent") ?? "",
    headers.get("accept") ?? "",
    headers.get("accept-language") ?? "",
    headers.get("x-stainless-lang") ?? "",
    headers.get("x-stainless-package-version") ?? "",
    headers.get("anthropic-version") ?? "",
  ].join("\u0000");
  return { ip, fingerprint: hashFingerprint(fingerprintInput), client };
}

/** Tracks active request flights per IP with O(1) acquire/release operations. */
export class ActiveFlightTracker {
  private readonly activeByIp = new Map<string, number>();

  acquire(ip: string, limit: number): FlightPermit | FlightRejection {
    const active = this.activeByIp.get(ip) ?? 0;
    if (active >= limit) return { active, limit };
    const next = active + 1;
    this.activeByIp.set(ip, next);
    return { ip, active: next };
  }

  release(permit: FlightPermit): void {
    const active = this.activeByIp.get(permit.ip);
    if (active === undefined || active <= 1) {
      this.activeByIp.delete(permit.ip);
      return;
    }
    this.activeByIp.set(permit.ip, active - 1);
  }

  active(ip: string): number {
    return this.activeByIp.get(ip) ?? 0;
  }

  clear(): void {
    this.activeByIp.clear();
  }
}

export function isFlightRejection(value: FlightPermit | FlightRejection): value is FlightRejection {
  return "limit" in value;
}

export const activeFlights = new ActiveFlightTracker();
