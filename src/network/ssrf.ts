// SSRF guard: DNS resolution allowlists and destination validation for outbound fetch.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { GatewayError } from "../protocol/gateway-error";
import type { SsrfPolicy } from "../config/network";

const DNS_CACHE_TTL_MS = 60_000;
const DNS_CACHE_MAX = 64;
const dnsCache = new Map<string, { addrs: string[]; at: number }>();

/** Bounds cache memory: evicts oldest entries once size exceeds the cap, not just expired ones. */
function cacheDnsResult(hostname: string, addrs: string[], now: number): void {
  dnsCache.delete(hostname);
  dnsCache.set(hostname, { addrs, at: now });
  while (dnsCache.size > DNS_CACHE_MAX) {
    const oldest = dnsCache.keys().next().value;
    if (oldest === undefined) break;
    dnsCache.delete(oldest);
  }
}


export interface ValidatedDestination {
  readonly hostname: string;
  readonly resolvedAddress: string;
  readonly port: number;
}

function ipv4Number(address: string): number {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part)))
    throw new Error("invalid IPv4");
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) throw new Error("invalid IPv4");
  return (((octets[0]! << 24) >>> 0) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function ipv6Bytes(address: string): Uint8Array {
  const value = address.toLowerCase().split("%", 1)[0]!;
  if (value.includes(".")) {
    const split = value.lastIndexOf(":");
    if (split < 0) throw new Error("invalid IPv6");
    const mapped = ipv4Number(value.slice(split + 1));
    return ipv6Bytes(
      `${value.slice(0, split)}:${(mapped >>> 16).toString(16)}:${(mapped & 0xffff).toString(16)}`,
    );
  }
  const halves = value.split("::");
  if (halves.length > 2) throw new Error("invalid IPv6");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) throw new Error("invalid IPv6");
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) throw new Error("invalid IPv6");
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part)))
    throw new Error("invalid IPv6");
  const bytes = new Uint8Array(16);
  groups.forEach((part, index) => {
    const n = Number.parseInt(part, 16);
    bytes[index * 2] = n >>> 8;
    bytes[index * 2 + 1] = n & 255;
  });
  return bytes;
}

function cidrContains(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/");
  if (!network || prefixText === undefined) return false;
  // A present-but-blank prefix (`"10.0.0.0/"`) must be refused, not coerced.
  // `Number("")` is 0 and `""` is not `undefined`, so the guard below used to fall
  // through with `prefix = 0` — and a /0 admits every address of its family. An
  // operator's typo therefore silently widened the allowlist to the whole IPv4
  // space, including the link-local metadata endpoint this guard exists to refuse.
  //
  // Requiring a run of digits (after trimming) also refuses the exotic spellings
  // `Number` accepts for zero — `-0`, `+0`, `0x0`, `0b0`, `0o0`, `0.0` — all of
  // which are typos rather than a deliberate "allow everything". Only a written
  // `0` means that, which is the next branch's business.
  const prefixDigits = prefixText.trim();
  if (!/^\d+$/.test(prefixDigits)) return false;
  const prefix = Number(prefixDigits);
  const family = isIP(address);
  if (
    family !== isIP(network) ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > (family === 4 ? 32 : 128)
  )
    return false;
  if (family === 4) {
    const bits = 32 - prefix;
    return bits === 32 ? true : ipv4Number(address) >>> bits === ipv4Number(network) >>> bits;
  }
  const a = ipv6Bytes(address);
  const n = ipv6Bytes(network);
  for (let index = 0; index < prefix; index++) {
    const byte = Math.floor(index / 8);
    const bit = 7 - (index % 8);
    if (((a[byte]! >> bit) & 1) !== ((n[byte]! >> bit) & 1)) return false;
  }
  return true;
}

function unsafeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = ipv4Number(address);
    return [
      [0, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0a80000, 16],
      [0xc0000000, 24],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
    ].some(([base, prefix]) => n >>> (32 - prefix!) === base! >>> (32 - prefix!));
  }
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  const first = (bytes[0]! << 8) | bytes[1]!;
  const first32 = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  // first === 0 also covers the IPv4-mapped (`::ffff:0:0/96`) and
  // IPv4-compatible (deprecated) ranges, including `::ffff:127.0.0.1`.
  // 2002::/16 (6to4) and 64:ff9b::/96 (NAT64) embed an IPv4 address in the
  // tail bits and translate it at a gateway — treat the embedded range as
  // unsafe by checking its translated IPv4 bytes. Compare the 16-bit leading
  // group (`first`), not the full 32-bit `first32`.
  if (first === 0x2002) return unsafeAddress(embeddedIpv4(bytes, 2));
  if (first === 0x0064 && bytes[2] === 0xff && bytes[3] === 0x9b)
    return unsafeAddress(embeddedIpv4(bytes, 12));
  return (
    first === 0 ||
    first === 1 ||
    first32 === 0x20010db8 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    bytes[0] === 0xff
  );
}

/** Extracts the 4-byte IPv4 embedded at `byteOffset` of an IPv6 address. */
function embeddedIpv4(bytes: Uint8Array, byteOffset: number): string {
  return [
    bytes[byteOffset]!,
    bytes[byteOffset + 1]!,
    bytes[byteOffset + 2]!,
    bytes[byteOffset + 3]!,
  ].join(".");
}

export function isAddressAllowed(address: string, policy: SsrfPolicy): boolean {
  if (isIP(address) === 0) return false;
  if (policy.allowedNetworks?.some((cidr) => cidrContains(address, cidr))) return true;
  return policy.allowPrivate === true || !unsafeAddress(address);
}
export function validateResolvedAddresses(
  addresses: readonly string[],
  policy: SsrfPolicy,
): string {
  if (addresses.length === 0 || addresses.some((address) => !isAddressAllowed(address, policy))) {
    throw new GatewayError("invalid_request", 400, "The upstream address this route resolves to is not allowed. Point the provider at a permitted host.");
  }
  return addresses[0]!;
}

export async function resolveAllAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) throw new GatewayError("transport_closed", 499, "request was cancelled");
  if (isIP(hostname)) return [hostname];
  const cached = dnsCache.get(hostname);
  if (cached) {
    if (Date.now() - cached.at < DNS_CACHE_TTL_MS) return cached.addrs;
    // Stale: a cached answer past the TTL must not pin a hostname to addresses
    // the resolver may have already re-pointed (provider failover, DNS rebinding
    // rotation). Drop it and fall through to a fresh lookup.
    dnsCache.delete(hostname);
  }
  try {
    // `dns.lookup` follows the OS resolver, including hosts entries and a VPN
    // stub that replaces resolv.conf at runtime. `resolve4`/`resolve6` query
    // c-ares directly, so a tunnel resolver that refuses or drops those
    // queries fails direct egress even while the OS can still answer.
    // AAAA-only resolvers can stall, so the OS lookup itself has a deadline.
    const rows = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS lookup timed out")), 5_000)),
    ]);
    const addresses = [...new Set(rows.filter((row) => row.family === 4).map((row) => row.address))];
    const selected = addresses.length > 0 ? addresses : [...new Set(rows.map((row) => row.address))];
    if (selected.length === 0) throw new Error("no DNS answers");
    cacheDnsResult(hostname, selected, Date.now());
    return selected;
  } catch (error) {
    // A deadline/abort surfaces as 499 (client cancelled), never 400 — the
    // same contract the dispatch layer uses for a timed-out upstream dial.
    if (signal.aborted) throw new GatewayError("transport_closed", 499, "request was cancelled");
    // The hostname belongs to the provider's configuration, not to the
    // caller's request: a resolver that cannot answer is a network failure,
    // and reporting it as the caller's 400 `invalid_request` blamed the
    // request for an upstream host that does not resolve.
    throw new GatewayError(
      "transport_unavailable",
      502,
      "upstream DNS resolution failed",
      { cause: String(error) },
      "network",
    );
  }
}

export async function resolveAndValidateOnce(
  hostname: string,
  policy: SsrfPolicy,
  signal: AbortSignal,
  port = 443,
): Promise<ValidatedDestination> {
  const addresses = await resolveAllAddresses(hostname, signal);
  const resolvedAddress = validateResolvedAddresses(addresses, policy);
  return { hostname, resolvedAddress, port };
}
