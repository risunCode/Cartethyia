// Client-IP presentation masking.
//
// This module used to also carry a telemetry redactor that rewrote any string
// containing a credential-shaped token into a placeholder. It was meant for
// display, but `***REDACTED***` in a captured body is indistinguishable from
// `***REDACTED***` in a payload that was actually sent — so a memory-review
// turn quoting one JWT rendered as a fully redacted message, and a 400 from
// the provider looked like the gateway had mangled the request.
//
// Payload bodies are stored verbatim now. The upstream already refuses and
// reports credentials on its own; a second, string-sniffing layer only
// destroys the evidence needed to read a failure.

/**
 * Masks a client IP for presentation: IPv4 keeps the first three octets
 * (`203.0.113.xxx`), IPv6 the first four hextets. Empty input stays empty;
 * unparseable input is fully masked. Mirrors the 21.beta privacy contract:
 * storage keeps raw values, only the read path masks.
 */
export function maskClientIp(value: string): string;
export function maskClientIp(value: null | undefined): null;
export function maskClientIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ip = value.trim();
  if (ip.length === 0) return ip;
  // IPv4-mapped IPv6 (`::ffff:203.0.113.7`): mask the embedded IPv4 tail so
  // the most common localhost/proxied shape stays readable.
  const lastColon = ip.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".");
    if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
      return `${ip.slice(0, lastColon + 1)}${octets.slice(0, 3).join(".")}.xxx`;
    }
    return "***";
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return parts.length >= 4 ? `${parts.slice(0, 4).join(":")}:xxxx` : "xxxx";
  }
  const octets = ip.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    return `${octets.slice(0, 3).join(".")}.xxx`;
  }
  return "***";
}
