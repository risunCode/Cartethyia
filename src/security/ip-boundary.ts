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
  // Recognize the mapped range STRUCTURALLY, not by its compressed spelling. The
  // old `startsWith("::ffff:")` test missed any form that writes the leading zero
  // groups out — `0:0:0:0:0:ffff:7f00:1` is the same host as `::ffff:127.0.0.1`,
  // but it failed the prefix test, fell through to `ipv6ToBigInt`, and was treated
  // as an unrelated IPv6 address. The trust check then refused a peer the allowlist
  // covered, and `canonicalClientIpKey` minted a second key for one host — which is
  // what the one-active-key-per-IP rule deduplicates on.
  //
  // A mapped address is `::ffff:<32 bits>`, i.e. the first 80 bits are zero and the
  // next 16 are `0xffff`. Matching that is the same test `isIP` uses internally.
  const tail = mappedIpv4Tail(value);
  if (tail === undefined) return address;
  // `mappedIpv4Tail` always returns two hex groups, so the dotted and hex
  // spellings have already converged by here.
  const groups = tail.split(":");
  if (groups.length !== 2) return address;
  const high = Number.parseInt(groups[0] ?? "", 16);
  const low = Number.parseInt(groups[1] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff)
    return address;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/**
 * The 32-bit tail of an IPv4-mapped IPv6 address, or `undefined` when `value` is
 * not one. Accepts every spelling of the same address: `::ffff:1.2.3.4`,
 * `::ffff:102:304`, `0:0:0:0:0:ffff:102:304`, and `::ffff:0:102:304`.
 *
 * Works by normalizing to exactly eight 16-bit groups first. That is the only way
 * to compare spellings: a dotted tail is written as ONE colon-separated token but
 * occupies TWO group slots, so any check that counts `split(":")` entries gets the
 * position of the `ffff` marker wrong.
 */
function mappedIpv4Tail(value: string): string | undefined {
  const groups = normalizeIpv6Groups(value);
  if (groups === undefined) return undefined;
  // The first five groups (80 bits) must be zero, and the sixth must be `ffff`.
  for (let index = 0; index < 5; index += 1) {
    if (groups[index] !== "0") return undefined;
  }
  if (groups[5] !== "ffff") return undefined;
  const high = groups[6];
  const low = groups[7];
  if (high === undefined || low === undefined) return undefined;
  return `${high}:${low}`;
}

/**
 * An IPv6 literal as exactly eight lowercase 16-bit hex groups, or `undefined`
 * when it is not one. Expands a `::` run and converts a trailing dotted quad into
 * the two groups it represents.
 */
function normalizeIpv6Groups(value: string): string[] | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;
  const doubleIndex = text.indexOf("::");
  // More than one `::` is invalid, as is a `::` inside a group.
  if (doubleIndex !== text.lastIndexOf("::")) return undefined;

  const headText = doubleIndex >= 0 ? text.slice(0, doubleIndex) : text;
  const tailText = doubleIndex >= 0 ? text.slice(doubleIndex + 2) : "";
  const head = headText.length > 0 ? headText.split(":") : [];
  const tail = tailText.length > 0 ? tailText.split(":") : [];

  // A dotted quad is a single token that fills two groups.
  const expandDotted = (tokens: string[]): string[] | undefined => {
    const last = tokens[tokens.length - 1];
    if (last === undefined || !last.includes(".")) return tokens;
    const quad = last.split(".");
    if (quad.length !== 4) return undefined;
    const octets = quad.map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const [a, b, c, d] = octets;
    if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    return [...tokens.slice(0, -1), high, low];
  };

  const expandedHead = expandDotted(head);
  const expandedTail = expandDotted(tail);
  if (expandedHead === undefined || expandedTail === undefined) return undefined;

  let full: string[];
  if (doubleIndex >= 0) {
    const missing = 8 - expandedHead.length - expandedTail.length;
    // `::` must stand for at least one group, so exactly-8 without it is invalid.
    if (missing < 1) return undefined;
    full = [...expandedHead, ...Array.from({ length: missing }, () => "0"), ...expandedTail];
  } else {
    full = expandedHead;
  }
  if (full.length !== 8) return undefined;
  const normalized: string[] = [];
  for (const group of full) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    normalized.push(Number.parseInt(group, 16).toString(16));
  }
  return normalized;
}

function matchesCidr(address: string, cidr: string): boolean {
  const [network, rawPrefix] = cidr.split("/");
  if (!network) return false;
  // A bare address (`"127.0.0.1"`) has no prefix and means "this exact host". A
  // present-but-blank prefix (`"10.0.0.0/"`) must NOT be treated as /0: `Number("")`
  // is 0, and /0 matches every address — which made `isTrustedProxyPeer` true for
  // ANY peer, so the gateway believed a caller's own `X-Forwarded-For` and every
  // per-address decision downstream (abuse throttling, model bans, the audit
  // trail) read a forged value.
  //
  // Requiring a run of digits also refuses the exotic spellings `Number` accepts
  // for zero (`-0`, `+0`, `0x0`, `0b0`, `0o0`, `0.0`), all of which are typos
  // rather than a deliberate "trust everyone".
  const prefixText = rawPrefix === undefined ? undefined : rawPrefix.trim();
  if (prefixText !== undefined && !/^\d+$/.test(prefixText)) return false;
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
  // `platform` mode has no allowlist to match: the PaaS edge is the only way
  // in, which is what the mode asserts. See `TrustedProxyMode`.
  if (boundary.mode === "platform") return true;
  return boundary.allowlist?.some((entry) => matchesCidr(peer, entry)) ?? false;
}

/** Whether the TCP peer may vouch for forwarded headers (reverse-proxy trust). */
export function isTrustedProxyPeer(peer: string, boundary: TrustedProxyBoundary): boolean {
  return boundary.mode !== "disabled" && isTrustedPeer(peer, boundary);
}

/**
 * Client IP resolution behind a reverse proxy. `"disabled"` (default) always
 * trusts the raw TCP peer. `"trusted"` trusts proxy identity headers only when
 * the TCP peer itself matches `allowlist` (CIDR or exact address). `"platform"`
 * trusts them from any peer, for a PaaS edge that cannot be allowlisted.
 *
 * `CF-Connecting-IP` and `True-Client-IP` are preferred: both are single-valued
 * and overwritten by the edge, so they cannot carry a caller-supplied value.
 * The forwarded chain is read from its left end, which assumes the edge
 * *prepends* the address it observed — cloudflared's behavior, and the reason
 * the loopback allowlist works. An edge that instead *appends* leaves whatever
 * the caller sent at the left end, where it would be selected; a deployment
 * behind such an edge should send `CF-Connecting-IP`/`True-Client-IP` (both
 * overwritten) or a trusted-peer allowlist narrow enough that direct callers
 * cannot reach it. Which one Railway does is not established here.
 */
export function resolveClientIdentity(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): string {
  const fallback = unwrapMappedIpv4(peer);
  // `isTrustedProxyPeer`, not `isTrustedPeer`: the two differ by exactly the
  // `mode !== "disabled"` term, and gating on the latter meant a boundary carrying
  // BOTH `disabled` and an allowlist honored forwarded headers here while
  // `isTrustedProxyPeer` refused the same peer. The module then held two
  // contradictory answers to "is this peer trusted?" for one request, and
  // `securePolicyForRequest` — which uses the correct predicate — disagreed with
  // this function about the same peer.
  //
  // The consequence was the spoofing property: `{ mode: "disabled", allowlist:
  // [...] }` ignored `mode` entirely, so a caller able to reach the port named its
  // own client address — the dimension the per-IP abuse limits are counted on.
  if (!isTrustedProxyPeer(peer, boundary)) return fallback;
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
