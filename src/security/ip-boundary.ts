// Pure network identity matching: CIDR/IP helpers and trusted-proxy client identity.

import { isIP } from "node:net";
import type { TrustedProxyBoundary } from "../config";

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return undefined;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

function ipv6ToBigInt(address: string): bigint | undefined {
  const value = address.toLowerCase().split("%", 1)[0] ?? "";
  if (value.includes(".")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part)))
    return undefined;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  return result;
}

/**
 * Unwraps an IPv4-mapped IPv6 address to plain IPv4.
 *
 * Bun reports an IPv4 loopback peer as `::ffff:127.0.0.1` on Windows, and
 * `isIP` classifies it as IPv6 — so `ipv6ToBigInt` (which bails on a dotted
 * quad) never matched `127.0.0.1/32`. The trust check therefore failed for the
 * exact peer `TRUSTED_PROXY_CIDRS=127.0.0.1/32` is meant to cover, forwarded
 * headers were ignored, and every cloudflared request stored the loopback peer
 * as the client address. Accepts both the dotted and the hex (`::ffff:7f00:1`)
 * spelling.
 */
function unwrapMappedIpv4(address: string): string {
  const value = address.toLowerCase().split("%", 1)[0] ?? "";
  if (!value.startsWith("::ffff:")) return address;
  const tail = value.slice("::ffff:".length);
  if (isIP(tail) === 4) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2) return address;
  const high = Number.parseInt(groups[0] ?? "", 16);
  const low = Number.parseInt(groups[1] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff)
    return address;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function matchesCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/");
  if (!network) return false;
  // A mapped peer and a plain-IPv4 allowlist entry describe the same host.
  const subject = unwrapMappedIpv4(address);
  const base = unwrapMappedIpv4(network);
  const family = isIP(subject);
  if (family === 4) {
    const value = ipv4ToNumber(subject);
    const networkValue = ipv4ToNumber(base);
    if (value === undefined || networkValue === undefined) return false;
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value >>> 0) & mask) === ((networkValue >>> 0) & mask);
  }
  if (family !== 6) return false;
  const value = ipv6ToBigInt(subject);
  const networkValue = ipv6ToBigInt(base);
  if (value === undefined || networkValue === undefined) return false;
  const prefix = prefixText === undefined ? 128 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (networkValue >> shift);
}

function isTrustedPeer(peer: string, boundary: TrustedProxyBoundary): boolean {
  return boundary.allowlist?.some((entry) => matchesCidr(peer, entry)) ?? false;
}

/** Whether the TCP peer may vouch for forwarded headers (reverse-proxy trust). */
export function isTrustedProxyPeer(peer: string, boundary: TrustedProxyBoundary): boolean {
  return boundary.mode === "trusted" && isTrustedPeer(peer, boundary);
}

/**
 * Client IP resolution behind a reverse proxy. `"disabled"` (default) always
 * trusts the raw TCP peer. `"trusted"` trusts proxy identity headers only
 * when the TCP peer itself matches `allowlist` (CIDR or exact address).
 *
 * Cloudflare's `CF-Connecting-IP` is preferred over the forwarded chain,
 * followed by `True-Client-IP`, `X-Forwarded-For`, and `X-Real-IP`. This keeps
 * the original address when cloudflared/Railway rewrites the ordinary chain.
 */
export function resolveClientIdentity(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): string {
  const fallback = unwrapMappedIpv4(peer);
  if (boundary.mode === "disabled" || !isTrustedPeer(peer, boundary)) return fallback;
  const headerNames = ["cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"];
  for (const name of headerNames) {
    const values = (request.headers.get(name) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    // A proxy may itself forward a mapped form; store the canonical spelling
    // so one host is one dimension value rather than two.
    if (values[0]) return unwrapMappedIpv4(values[0]);
  }
  return fallback;
}

/**
 * Produces a stable, family-tagged identity key for database uniqueness.
 * Mapped IPv4 and alternate IPv6 spellings collapse to one canonical address.
 */
export function canonicalClientIpKey(address: string): string | undefined {
  const normalized = unwrapMappedIpv4(address);
  const family = isIP(normalized);
  if (family === 4) {
    const value = ipv4ToNumber(normalized);
    return value === undefined ? undefined : `v4:${value}`;
  }
  if (family === 6) {
    const value = ipv6ToBigInt(normalized);
    return value === undefined ? undefined : `v6:${value.toString(16).padStart(32, "0")}`;
  }
  return undefined;
}
