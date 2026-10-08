/**
 * Client-IP presentation masking.
 *
 * Storage keeps the raw address so an operator can still investigate, and the
 * read path drops the last label so a support screenshot does not publish a
 * customer's IP.
 *
 * This module used to also carry a telemetry redactor that rewrote any string
 * containing a credential-shaped token into `***REDACTED***`. It was removed:
 * a placeholder in a captured body is indistinguishable from a placeholder in
 * a payload that was actually sent, so one quoted JWT in a long message made
 * the whole message read as redacted — and a provider 400 looked like the
 * gateway had mangled the request. These cases pin only the masking that
 * remains.
 */
import { describe, expect, test } from "bun:test";
import { maskClientIp } from "../../src/observability/redaction";

describe("maskClientIp", () => {
  test("keeps the first three IPv4 octets", () => {
    expect(maskClientIp("203.0.113.7")).toBe("203.0.113.xxx");
  });

  test("masks the embedded IPv4 tail of a mapped IPv6 address", () => {
    // The common localhost/proxied shape; masking the whole thing would lose
    // the fact that it is a mapped address.
    expect(maskClientIp("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.xxx");
  });

  test("keeps the first four IPv6 hextets", () => {
    expect(maskClientIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3:8d3:xxxx");
  });

  test("fully masks an IPv6 address too short to keep four hextets", () => {
    expect(maskClientIp("::1")).toBe("xxxx");
  });

  test("returns null for null or undefined", () => {
    // Distinguishing "no address" from "an address" matters: a null means the
    // gateway never resolved one, which is a different report than a masked one.
    expect(maskClientIp(null)).toBeNull();
    expect(maskClientIp(undefined)).toBeNull();
  });

  test("returns an empty string for an empty address", () => {
    expect(maskClientIp("")).toBe("");
    expect(maskClientIp("   ")).toBe("");
  });

  test("fully masks input it cannot parse", () => {
    // Fail closed: an unrecognised shape is not partially published.
    expect(maskClientIp("not-an-ip")).toBe("***");
    expect(maskClientIp("1.2.3")).toBe("***");
    expect(maskClientIp("1.2.3.4.5")).toBe("***");
  });

  test("tolerates surrounding whitespace", () => {
    expect(maskClientIp("  203.0.113.7  ")).toBe("203.0.113.xxx");
  });

  test("the masked form ends in the placeholder, never the original final octet", () => {
    // Stated as a shape rather than a substring test: `10.0.0.1` masked to
    // `10.0.0.xxx` legitimately still *contains* the character "1" in an earlier
    // octet, so a naive `not.toContain(lastOctet)` is not the property. The
    // property is that the final label is the placeholder.
    for (const address of ["203.0.113.7", "10.0.0.1", "255.255.255.255"]) {
      const masked = maskClientIp(address);
      expect(masked.endsWith(".xxx")).toBe(true);
      expect(masked).toBe(`${address.split(".").slice(0, 3).join(".")}.xxx`);
    }
  });
});
