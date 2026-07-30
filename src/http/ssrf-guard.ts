/**
 * SSRF guard — blocks server-side fetches to private, loopback, link-local,
 * and cloud-metadata IPs. Applied to all user-supplied URLs (proxy pools).
 *
 * Reference: 9router `shared/utils/ssrfGuard.js`
 */

/** Hostnames that are always blocked regardless of DNS resolution. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0"]);

/** Suffixes that indicate internal/non-routable hosts. */
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

/** Protocols allowed for proxy URLs. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

/**
 * Checks if an IPv4 address string belongs to a private/reserved range.
 * Handles dotted-quad notation only (no CIDR).
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (a === undefined || b === undefined) return false;

  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local (cloud metadata)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0 — unspecified
  if (a === 0) return true;

  return false;
}

/**
 * Checks if a hostname (IP literal or domain) is private/blocked.
 * For domain names, checks known patterns. For IP literals, checks ranges.
 */
function isBlockedIp(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (ip === "::1") return true;

  const firstHextet = /^([0-9a-f]{1,4}):/.exec(ip)?.[1];
  if (firstHextet) {
    const value = Number.parseInt(firstHextet, 16);
    if ((value >= 0xfe80 && value <= 0xfebf) || (value >= 0xfc00 && value <= 0xfdff)) return true;
  }

  // IPv4-mapped IPv6 (URL constructor normalizes to hex: ::ffff:7f00:1)
  if (ip.startsWith("::ffff:")) {
    const inner = ip.slice(7);
    if (inner.includes(":")) {
      if (inner.startsWith("7f") || inner.startsWith("a9fe") || inner.startsWith("a") || inner.startsWith("c0a8")) return true;
    } else if (isPrivateIPv4(inner)) {
      return true;
    }
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return isPrivateIPv4(ip);
  }

  return false;
}

function assertPublicIp(address: string): void {
  if (isBlockedIp(address)) throw new Error(`Blocked private IP address: "${address}"`);
}

/**
 * Checks if a hostname (IP literal or domain) is private/blocked.
 * For domain names, checks known patterns. For IP literals, checks ranges.
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(h)) return true;

  for (const suffix of BLOCKED_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }

  if (h === "metadata.google.internal" || h === "instance-data") return true;

  try {
    assertPublicIp(h);
    return false;
  } catch {
    return true;
  }
}

/**
 * Validates that a URL points to a public, routable address.
 * Throws with a descriptive message if the URL is blocked.
 *
 * @param raw - The raw URL string to validate
 * @param label - Context label for error messages (e.g. "proxy pool entry")
 */
export function assertPublicUrl(raw: string, label = "URL"): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label}: "${raw}" is not a valid URL`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Invalid ${label}: protocol "${url.protocol}" not allowed (use http, https, or socks5)`);
  }

  const hostname = url.hostname.toLowerCase();

  if (isBlockedHost(hostname)) {
    throw new Error(`Invalid ${label}: "${hostname}" is blocked (private/loopback/internal)`);
  }
}

function isIpLiteral(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, "");
  return address.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address);
}

/**
 * Validates a URL immediately before dispatch, including all DNS-resolved
 * targets, to prevent DNS rebinding after configuration-time validation.
 */
export async function assertPublicUrlAtDispatch(raw: string): Promise<void> {
  assertPublicUrl(raw);

  const hostname = new URL(raw).hostname;
  if (isIpLiteral(hostname)) return;

  const records = await Bun.dns.lookup(hostname, { family: 0 });
  for (const record of records) assertPublicIp(record.address);
}

/**
 * Fetches a user-supplied URL only after dispatch-time validation and follows
 * redirects manually so every redirect target receives the same validation.
 */
export async function fetchWithSsrfGuard(url: string, init: RequestInit, maxRedirects = 5): Promise<Response> {
  let target = url;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    await assertPublicUrlAtDispatch(target);
    const response = await fetch(target, { ...init, redirect: "manual" });
    const location = response.headers.get("location");

    if (response.status < 300 || response.status >= 400 || !location) return response;
    target = new URL(location, target).toString();
  }

  throw new Error("Too many redirects while fetching user-supplied URL");
}

/**
 * Validates a URL and returns a clean error message instead of throwing.
 * Returns null if valid, error string if blocked.
 */
export function validatePublicUrl(raw: string, label = "URL"): string | null {
  try {
    assertPublicUrl(raw, label);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
