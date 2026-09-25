import { describe, expect, test } from "bun:test";
import { canonicalClientIpKey, resolveClientIdentity } from "../../src/security/ip-boundary";
import type { TrustedProxyBoundary } from "../../src/config";

describe("trusted proxy boundary", () => {
  test("matches IPv6 peers against IPv6 CIDR allowlists", () => {
    const request = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(
      resolveClientIdentity(
        request,
        { mode: "trusted", allowlist: ["2001:db8::/32"] } as TrustedProxyBoundary,
        "2001:db8::1",
      ),
    ).toBe("203.0.113.9");
  });
  test("prefers Cloudflare's connecting address over forwarded hops", () => {
    const request = new Request("https://gateway.test/v1/chat/completions", {
      headers: {
        "cf-connecting-ip": "198.51.100.8",
        "x-forwarded-for": "203.0.113.9, 10.0.0.4",
      },
    });
    expect(
      resolveClientIdentity(
        request,
        { mode: "trusted", allowlist: ["::1/128"] } as TrustedProxyBoundary,
        "::1",
      ),
    ).toBe("198.51.100.8");
  });

  test("falls back to X-Real-IP when the proxy omits forwarded-for", () => {
    const request = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect(
      resolveClientIdentity(
        request,
        { mode: "trusted", allowlist: ["127.0.0.1/32"] } as TrustedProxyBoundary,
        "127.0.0.1",
      ),
    ).toBe("198.51.100.7");
  });

  test("ignores forwarded identity from an untrusted IPv6 peer", () => {
    const request = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(
      resolveClientIdentity(
        request,
        { mode: "trusted", allowlist: ["2001:db8::/32"] } as TrustedProxyBoundary,
        "2001:db9::1",
      ),
    ).toBe("2001:db9::1");
  });

  // Bun reports an IPv4 loopback peer as `::ffff:127.0.0.1` on Windows, which
  // `isIP` classifies as IPv6. Before the mapped form was unwrapped, a
  // cloudflared peer on 127.0.0.1 failed the `127.0.0.1/32` trust check and
  // every request stored the loopback address as its client IP.
  test("trusts an IPv4-mapped loopback peer against an IPv4 allowlist", () => {
    const request = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "cf-connecting-ip": "198.51.100.11" },
    });
    for (const peer of ["::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1"]) {
      expect(
        resolveClientIdentity(
          request,
          { mode: "trusted", allowlist: ["127.0.0.1/32"] } as TrustedProxyBoundary,
          peer,
        ),
      ).toBe("198.51.100.11");
    }
  });

  test("normalizes a mapped peer to plain IPv4 when no header is present", () => {
    const request = new Request("https://gateway.test/v1/chat/completions");
    expect(
      resolveClientIdentity(
        request,
        { mode: "trusted", allowlist: ["127.0.0.1/32"] } as TrustedProxyBoundary,
        "::ffff:127.0.0.1",
      ),
    ).toBe("127.0.0.1");
  });

  test("normalizes a mapped address forwarded inside the header chain", () => {
    const request = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "x-forwarded-for": "::ffff:198.51.100.12, 10.0.0.4" },
    });
    expect(
      resolveClientIdentity(
        request,
        { mode: "trusted", allowlist: ["127.0.0.1/32"] } as TrustedProxyBoundary,
        "::ffff:127.0.0.1",
      ),
    ).toBe("198.51.100.12");
  });
  test("canonicalizes equivalent client IP spellings to one database key", () => {
    expect(canonicalClientIpKey("198.51.100.7")).toBe(canonicalClientIpKey("::ffff:198.51.100.7"));
    expect(canonicalClientIpKey("2001:db8::1")).toBe(
      canonicalClientIpKey("2001:0db8:0:0:0:0:0:1"),
    );
    expect(canonicalClientIpKey("not-an-ip")).toBeUndefined();
  });
});
