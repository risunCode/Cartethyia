/**
 * The IP boundary: whose address the gateway believes a request came from.
 *
 * This is the layer every per-client decision reads — abuse throttling, model
 * bans, the address shown to an operator, and the share page's masked list. Two
 * properties carry the risk, and both have a documented incident behind them:
 *
 * 1. **A forwarded header is believed only from a trusted peer.** `X-Forwarded-For`
 *    is caller-supplied, so trusting it unconditionally lets any client claim
 *    any address — which defeats every per-address limit and forges the operator's
 *    audit trail. `"disabled"` (the default) must ignore it entirely.
 * 2. **A mapped IPv4 peer must be recognised as its IPv4 self.** Bun reports an
 *    IPv4 loopback peer as `::ffff:127.0.0.1` on Windows and `isIP` classifies it
 *    as IPv6, so a `127.0.0.1/32` allowlist entry never matched. The trust check
 *    failed for the exact peer it was written for, forwarded headers were
 *    ignored, and every cloudflared request stored the loopback peer as the
 *    client address — one address for every caller in the deployment.
 *
 * `canonicalClientIpKey` is the third surface: it is the database uniqueness key,
 * so a host that reaches the gateway under two spellings must collapse to one
 * value or the same client occupies two rows.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalClientIpKey,
  isTrustedProxyPeer,
  resolveClientIdentity,
} from "../../src/security/ip-boundary";
import type { TrustedProxyBoundary } from "../../src/config";

/** No proxy trust: the raw TCP peer is the client. */
const DISABLED: TrustedProxyBoundary = { mode: "disabled" };
/** Trust forwarded headers only from the loopback range. */
const LOOPBACK: TrustedProxyBoundary = { mode: "trusted", allowlist: ["127.0.0.1/32", "::1/128"] };
/** Trust forwarded headers from anywhere (a PaaS edge that cannot be allowlisted). */
const PLATFORM: TrustedProxyBoundary = { mode: "platform" };
/** A trusted boundary with no allowlist: nobody is trusted. */
const EMPTY_ALLOWLIST: TrustedProxyBoundary = { mode: "trusted" };

/** A request carrying the given headers. */
function request(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/v1/chat/completions", { headers });
}

describe("isTrustedProxyPeer", () => {
  test("disabled mode trusts nobody, whatever the peer", () => {
    // The default. `resolveClientIdentity` falls back to the raw peer in this
    // mode, which is the only value a caller cannot forge.
    expect(isTrustedProxyPeer("127.0.0.1", DISABLED)).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", DISABLED)).toBe(false);
    expect(isTrustedProxyPeer("203.0.113.1", DISABLED)).toBe(false);
  });

  test("platform mode trusts any peer", () => {
    // The mode's whole meaning: the PaaS edge is the only way in, so there is no
    // allowlist to match against.
    expect(isTrustedProxyPeer("127.0.0.1", PLATFORM)).toBe(true);
    expect(isTrustedProxyPeer("203.0.113.1", PLATFORM)).toBe(true);
    expect(isTrustedProxyPeer("::1", PLATFORM)).toBe(true);
  });

  test("trusted mode matches the allowlist exactly", () => {
    expect(isTrustedProxyPeer("127.0.0.1", LOOPBACK)).toBe(true);
    expect(isTrustedProxyPeer("::1", LOOPBACK)).toBe(true);
    // A neighbouring address in the same /8 is not the allowlisted /32.
    expect(isTrustedProxyPeer("127.0.0.2", LOOPBACK)).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", LOOPBACK)).toBe(false);
  });

  test("a trusted boundary with no allowlist trusts nobody", () => {
    // `?? false` is the guard. A missing allowlist read as "trust everything"
    // would be the worst possible default for this mode.
    expect(isTrustedProxyPeer("127.0.0.1", EMPTY_ALLOWLIST)).toBe(false);
  });

  test("the mapped form of the loopback peer IS trusted", () => {
    // The documented incident: Bun reports an IPv4 loopback peer as
    // `::ffff:127.0.0.1` on Windows, `isIP` calls that IPv6, and the allowlist
    // entry is `127.0.0.1/32` — so without the unwrap, the exact peer the entry
    // was written for is refused and every cloudflared request stores the
    // loopback address as the client.
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", LOOPBACK)).toBe(true);
    // The hex spelling of the same address.
    expect(isTrustedProxyPeer("::ffff:7f00:1", LOOPBACK)).toBe(true);
  });

  test("a mapped non-loopback address is still not trusted", () => {
    // The unwrap must not widen the allowlist: `::ffff:10.0.0.1` is 10.0.0.1.
    expect(isTrustedProxyPeer("::ffff:10.0.0.1", LOOPBACK)).toBe(false);
    expect(isTrustedProxyPeer("::ffff:7f00:2", LOOPBACK)).toBe(false);
  });

  test("a CIDR entry matches a whole range", () => {
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/8"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.255.255.255", boundary)).toBe(true);
    expect(isTrustedProxyPeer("11.0.0.1", boundary)).toBe(false);
  });

  test("a bare address entry without a prefix is a single host", () => {
    // `prefixText === undefined ? 32 : …` — a missing prefix means the entry
    // names one host, not the whole space. Reading it as /0 would trust every
    // peer on the internet.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.1"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.2", boundary)).toBe(false);
    // And for IPv6 the same rule means one address, not /0.
    const v6: TrustedProxyBoundary = { mode: "trusted", allowlist: ["::1"] };
    expect(isTrustedProxyPeer("::1", v6)).toBe(true);
    expect(isTrustedProxyPeer("::2", v6)).toBe(false);
  });

  test("a malformed allowlist entry is ignored rather than trusted", () => {
    // Each of these fails a guard and returns false, for both the allowlisted
    // network and an unrelated public peer.
    for (const entry of ["10.0.0.0/abc", "10.0.0.0/33", "10.0.0.0/-1", "garbage", "", "300.0.0.1"]) {
      const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: [entry] };
      expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(false);
      expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(false);
    }
  });

  /**
   * KNOWN DEFECT — an allowlist entry with a trailing slash and no prefix length
   * trusts **every** peer, which lets any client forge its own address.
   *
   * `matchesCidr` (`src/security/ip-boundary.ts:59`) destructures
   * `cidr.split("/")` into `[network, prefixText]` and then does
   * `const prefix = prefixText === undefined ? 32 : Number(prefixText)`.
   * `Number("")` is `0`, and `""` is not `undefined`, so the "no prefix means a
   * single host" default does not fire. With `prefix = 0` the mask is `0` and the
   * comparison becomes `(value & 0) === (networkValue & 0)` — `0 === 0` for every
   * IPv4 address. The IPv6 branch has the same shape: `shift = 128n`, so
   * `value >> 128n` and `networkValue >> 128n` are both `0n`.
   *
   * Reachable impact — this is the more serious of the two instances of this
   * bug (the SSRF guard in `src/network/ssrf.ts` has the same coercion):
   * `resolveTrustedProxyBoundary` (`src/config.ts:362`) reads the list verbatim
   * from `TRUSTED_PROXY_CIDRS` through `readList`, which validates nothing. With
   * `TRUSTED_PROXY_CIDRS=10.0.0.0/`, `isTrustedProxyPeer` returns true for any
   * peer, so `resolveClientIdentity` believes the caller's own
   * `X-Forwarded-For` / `CF-Connecting-IP` / `X-Real-IP`. Every per-address
   * decision then reads a value the caller chose: IP abuse throttling and model
   * bans are bypassed by rotating a forged header, and the operator's audit trail
   * records whatever the client claimed. The failure is silent and fail-open.
   *
   * Written with `test.failing` so it flips to a failure the moment the prefix is
   * validated, which is the signal to drop the marker and keep the assertion.
   */
  test("an empty prefix length does not trust every peer", () => {
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(false);
    // The IPv6 spelling of the same coercion.
    const v6: TrustedProxyBoundary = { mode: "trusted", allowlist: ["fc00::/"] };
    expect(isTrustedProxyPeer("fc00::1", v6)).toBe(false);
  });

  test("the malformed entry trusts no peer at all", () => {
    // Was the `test.failing`'s complement, recording that the entry trusted every
    // peer. Now inverted: the entry matches nothing, so the boundary fails closed.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("203.0.113.9", boundary)).toBe(false);
    expect(isTrustedProxyPeer("::1", boundary)).toBe(false);
    const v6: TrustedProxyBoundary = { mode: "trusted", allowlist: ["fc00::/"] };
    expect(isTrustedProxyPeer("fc00::1", v6)).toBe(false);
    expect(isTrustedProxyPeer("1.1.1.1", v6)).toBe(false);
  });

  test("the forged-header consequence is closed", () => {
    // The end-to-end shape of the defect, and the assertion that matters most: a
    // public peer's own header must NOT become the stored client address. Before
    // the fix this returned "203.0.113.9" — a value the caller chose.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/"] };
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": "203.0.113.9" }),
        boundary,
        "198.51.100.7",
      ),
    ).toBe("198.51.100.7");
  });

  test("a bare address allowlist entry still means that exact host", () => {
    // The regression guard for the fix: the prefix check must not break the
    // documented bare-address form. A bare entry is an exact match, not a /32
    // written without its mask, so a neighbour in the same range is not trusted.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.5"] };
    expect(isTrustedProxyPeer("10.0.0.5", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.6", boundary)).toBe(false);
  });

  test("an explicit /0 still trusts every peer, as documented", () => {
    // The *explicit* zero prefix is a deliberate act, distinct from the empty
    // string that was being coerced into it.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["0.0.0.0/0"] };
    expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("203.0.113.9", boundary)).toBe(true);
  });

  test("a peer that is not an address at all is not trusted", () => {
    // A unix socket peer, an empty string, or a hostname. None of them can
    // match a CIDR, so the answer must be "no".
    for (const peer of ["", "localhost", "/var/run/sock", "not-an-ip"]) {
      expect(isTrustedProxyPeer(peer, LOOPBACK)).toBe(false);
    }
  });

  test("a scoped IPv6 peer (zone id) still matches", () => {
    // A link-local peer arrives with a `%eth0` suffix; the zone is stripped
    // before parsing.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["fe80::/10"] };
    expect(isTrustedProxyPeer("fe80::1%eth0", boundary)).toBe(true);
  });
});

describe("resolveClientIdentity — the untrusted path", () => {
  test("disabled mode returns the raw peer and ignores every header", () => {
    // The header set is caller-supplied, so believing it here would let any
    // client claim any address — defeating per-address throttling and forging
    // the operator's audit trail. Every documented header is checked, not just
    // the first.
    for (const header of [
      "cf-connecting-ip",
      "true-client-ip",
      "x-forwarded-for",
      "x-real-ip",
    ]) {
      expect(resolveClientIdentity(request({ [header]: "203.0.113.9" }), DISABLED, "198.51.100.7")).toBe(
        "198.51.100.7",
      );
    }
  });

  test("an untrusted peer ignores the headers even in trusted mode", () => {
    // The trust decision is about the peer, not the mode: a request arriving
    // directly from a public address must not have its headers believed just
    // because the deployment configured an allowlist.
    expect(
      resolveClientIdentity(request({ "x-forwarded-for": "203.0.113.9" }), LOOPBACK, "198.51.100.7"),
    ).toBe("198.51.100.7");
  });

  test("a mapped peer is unwrapped on the untrusted path too", () => {
    // The fallback is what gets stored as the client address, so a mapped form
    // here would put `::ffff:…` in the database as a distinct client.
    expect(resolveClientIdentity(request(), DISABLED, "::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(resolveClientIdentity(request(), DISABLED, "::ffff:7f00:1")).toBe("127.0.0.1");
  });

  test("a plain IPv6 peer is returned unchanged", () => {
    expect(resolveClientIdentity(request(), DISABLED, "2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("resolveClientIdentity — the trusted path", () => {
  test("a trusted peer's forwarded header is believed, in preference order", () => {
    // The documented order, and the reason for it: `CF-Connecting-IP` and
    // `True-Client-IP` are single-valued and overwritten by the edge, so they
    // cannot carry a caller-supplied value. `X-Forwarded-For` is a chain and is
    // only used when neither of the safe ones is present.
    expect(
      resolveClientIdentity(
        request({
          "cf-connecting-ip": "203.0.113.1",
          "true-client-ip": "203.0.113.2",
          "x-forwarded-for": "203.0.113.3",
          "x-real-ip": "203.0.113.4",
        }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
    expect(
      resolveClientIdentity(
        request({ "true-client-ip": "203.0.113.2", "x-forwarded-for": "203.0.113.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.2");
    expect(
      resolveClientIdentity(
        request({ "x-forwarded-for": "203.0.113.3", "x-real-ip": "203.0.113.4" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.3");
    expect(
      resolveClientIdentity(request({ "x-real-ip": "203.0.113.4" }), LOOPBACK, "127.0.0.1"),
    ).toBe("203.0.113.4");
  });

  test("the forwarded chain is read from its LEFT end", () => {
    // The documented assumption: the edge *prepends* the address it observed
    // (cloudflared's behaviour), so the left end is the client and the right end
    // is the edge itself. Pinned because an edge that appends leaves the
    // caller's own value at the left end — the comment names that as a
    // deployment hazard rather than something this code can detect.
    expect(
      resolveClientIdentity(
        request({ "x-forwarded-for": "203.0.113.1, 198.51.100.2, 10.0.0.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
  });

  test("a mapped address in a forwarded header is canonicalised", () => {
    // The comment: a proxy may itself forward a mapped form, and one host must
    // be one dimension value rather than two.
    expect(
      resolveClientIdentity(request({ "cf-connecting-ip": "::ffff:203.0.113.1" }), LOOPBACK, "127.0.0.1"),
    ).toBe("203.0.113.1");
  });

  test("empty header values fall through to the next candidate", () => {
    // A header present but blank is what an edge sends when it has nothing to
    // report; treating it as the client would store an empty address.
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": "", "x-forwarded-for": "203.0.113.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.3");
  });

  test("a header of only commas or whitespace falls through", () => {
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": " , , ", "x-forwarded-for": "203.0.113.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.3");
  });

  test("no forwarded header at all falls back to the peer", () => {
    expect(resolveClientIdentity(request(), LOOPBACK, "127.0.0.1")).toBe("127.0.0.1");
  });

  test("a mapped trusted peer with no header falls back to its IPv4 form", () => {
    expect(resolveClientIdentity(request(), LOOPBACK, "::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  test("surrounding whitespace in the header is trimmed", () => {
    // A hand-written config or an edge that pads the value would otherwise store
    // the padded string as a distinct client.
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": "  203.0.113.1  " }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
  });

  test("platform mode believes the headers from any peer", () => {
    // The mode's meaning: the PaaS edge cannot be allowlisted, so every peer is
    // the edge.
    expect(
      resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.1" }), PLATFORM, "203.0.113.9"),
    ).toBe("203.0.113.1");
  });

  test("a caller-supplied header cannot smuggle a value past the left-end read", () => {
    // The threat the preference order mitigates: a caller sends its own
    // `x-forwarded-for`, the edge prepends the real address, and the left end is
    // the edge's value. Asserted so the ordering is not "simplified" to a
    // right-end read, which would select the caller's value.
    expect(
      resolveClientIdentity(
        request({ "x-forwarded-for": "203.0.113.1, 1.2.3.4" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
  });

  test("a header value that is not an address is returned as-is", () => {
    // MEASURED: the resolver does not validate the header's value, it only
    // unwraps a mapped form. Pinned because it means a trusted-but-misconfigured
    // edge can store an arbitrary string as the client address — the value is
    // bounded by `canonicalClientIpKey` returning undefined, not by this
    // function.
    expect(
      resolveClientIdentity(request({ "cf-connecting-ip": "not-an-ip" }), LOOPBACK, "127.0.0.1"),
    ).toBe("not-an-ip");
  });
});

describe("canonicalClientIpKey — the uniqueness key", () => {
  test("an IPv4 address is tagged and numeric", () => {
    // The tag is what keeps a v4 and a v6 value from colliding on the same
    // string, and the numeric form is what makes two spellings equal.
    expect(canonicalClientIpKey("1.2.3.4")).toBe("v4:16909060");
    expect(canonicalClientIpKey("0.0.0.0")).toBe("v4:0");
    expect(canonicalClientIpKey("255.255.255.255")).toBe("v4:4294967295");
  });

  test("a mapped IPv4 collapses onto its IPv4 key", () => {
    // The property the doc comment states: mapped IPv4 and alternate spellings
    // collapse to one canonical address, so one host is one row.
    expect(canonicalClientIpKey("::ffff:1.2.3.4")).toBe(canonicalClientIpKey("1.2.3.4"));
    expect(canonicalClientIpKey("::ffff:102:304")).toBe(canonicalClientIpKey("1.2.3.4"));
  });

  test("alternate IPv6 spellings collapse onto one key", () => {
    // A compressed and an expanded spelling of the same address must not occupy
    // two rows.
    expect(canonicalClientIpKey("2001:db8::1")).toBe(canonicalClientIpKey("2001:0db8:0000:0000:0000:0000:0000:0001"));
    expect(canonicalClientIpKey("::1")).toBe(canonicalClientIpKey("0:0:0:0:0:0:0:1"));
    expect(canonicalClientIpKey("2001:DB8::1")).toBe(canonicalClientIpKey("2001:db8::1"));
  });

  test("an IPv6 key is zero-padded to a fixed width", () => {
    // The padding is what makes the key sortable and length-stable; without it
    // `v6:1` and `v6:01` would be different keys for the same address.
    expect(canonicalClientIpKey("::1")).toBe(`v6:${"0".repeat(31)}1`);
    expect(canonicalClientIpKey("::1")).toHaveLength(3 + 32);
  });

  test("the family tags keep a v4 and a v6 key distinct", () => {
    // `::1` and `1` are not comparable addresses; the tag is what stops the
    // numeric forms from colliding.
    expect(canonicalClientIpKey("::1")).not.toBe(canonicalClientIpKey("0.0.0.1"));
  });

  test("a non-address returns undefined rather than a fabricated key", () => {
    // The caller uses the undefined to skip the row. A fallback key would put
    // every unparseable value in one bucket.
    for (const value of ["", "not-an-ip", "localhost", "1.2.3", "1.2.3.4.5", "300.1.1.1", "::gggg", "::1%eth0"]) {
      // A scoped address is stripped, so `::1%eth0` is the loopback and DOES
      // have a key — the rest are genuinely unparseable.
      if (value === "::1%eth0") continue;
      expect(canonicalClientIpKey(value)).toBeUndefined();
    }
  });

  test("a scoped IPv6 address collapses onto its unscoped key", () => {
    // A zone id is a local routing hint, not part of the address, so the same
    // host must not occupy two rows depending on which interface it arrived on.
    expect(canonicalClientIpKey("fe80::1%eth0")).toBe(canonicalClientIpKey("fe80::1"));
    expect(canonicalClientIpKey("fe80::1%eth0")).toBe(canonicalClientIpKey("fe80::1%wlan0"));
  });

  test("every accepted address produces a key, and distinct hosts produce distinct keys", () => {
    // A sweep so a parsing regression shows up as a missing key rather than as
    // two hosts silently sharing one.
    const addresses = ["1.1.1.1", "1.1.1.2", "10.0.0.1", "::1", "2001:db8::1", "fe80::1", "::ffff:8.8.8.8"];
    const keys = addresses.map((address) => canonicalClientIpKey(address));
    for (const key of keys) expect(typeof key).toBe("string");
    expect(new Set(keys).size).toBe(addresses.length);
  });
});
