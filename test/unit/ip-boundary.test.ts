/**
 * Trusted-proxy boundary and client-identity rules, as units.
 *
 * `src/security/ip-boundary.ts` owns one security decision — may this TCP peer
 * vouch for the forwarded client address? — and two normalizations that depend
 * on it: the client identity stored for a request, and the family-tagged key
 * that deduplicates that identity in the database. All three are pure
 * functions, so every edge here is reachable without a socket, a database, or a
 * live proxy.
 *
 * The property that matters most is negative: an untrusted peer's forwarded
 * header must never be honored. A regression there is silent — the gateway
 * keeps serving, and only the stored client address is wrong, which is exactly
 * what lets one caller exhaust or evade the per-IP rules.
 *
 * A second, subtler property is that one host is one identity. The gateway is
 * reachable both directly and through cloudflared, so the same caller can
 * appear as plain IPv4, as `::ffff:127.0.0.1`, or as `::ffff:7f00:1`; if those
 * do not collapse to a single key, a per-IP limit becomes a per-spelling limit.
 */
import { describe, expect, test } from "bun:test";
import type { TrustedProxyBoundary } from "../../src/config";
import {
  canonicalClientIpKey,
  isTrustedProxyPeer,
  resolveClientIdentity,
} from "../../src/security/ip-boundary";

/** A `trusted`-mode boundary over the given CIDR/exact-address entries. */
function trusted(allowlist: readonly string[]): TrustedProxyBoundary {
  return { mode: "trusted", allowlist };
}

const DISABLED: TrustedProxyBoundary = { mode: "disabled" };
const PLATFORM: TrustedProxyBoundary = { mode: "platform" };
const LOOPBACK = trusted(["127.0.0.1/32"]);

/** Builds a request carrying only the headers a case cares about. */
function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/", { headers });
}

describe("isTrustedProxyPeer: IPv4 CIDR matching", () => {
  test("matches an exact /32", () => {
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["127.0.0.1/32"]))).toBe(true);
  });

  test("rejects the neighbour address of an exact /32", () => {
    // The whole point of /32 is that only the loopback is the proxy.
    expect(isTrustedProxyPeer("127.0.0.2", trusted(["127.0.0.1/32"]))).toBe(false);
  });

  test("treats a bare address as a /32", () => {
    // `prefixText === undefined` defaults to the full-width mask; an operator
    // writing an exact address must not silently get a broader match.
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["127.0.0.1"]))).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.2", trusted(["127.0.0.1"]))).toBe(false);
  });

  test("matches the whole /8 including both ends", () => {
    const boundary = trusted(["10.0.0.0/8"]);
    expect(isTrustedProxyPeer("10.0.0.0", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.255.255.255", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.128.0.1", boundary)).toBe(true);
  });

  test("rejects the addresses immediately outside a /8", () => {
    // Off-by-one at the mask boundary is the classic CIDR bug: `9.x` and `11.x`
    // must not be swallowed by a `10.0.0.0/8` entry.
    const boundary = trusted(["10.0.0.0/8"]);
    expect(isTrustedProxyPeer("9.255.255.255", boundary)).toBe(false);
    expect(isTrustedProxyPeer("11.0.0.0", boundary)).toBe(false);
  });

  test("matches a /24 with the last octet unconstrained", () => {
    const boundary = trusted(["192.168.1.0/24"]);
    expect(isTrustedProxyPeer("192.168.1.0", boundary)).toBe(true);
    expect(isTrustedProxyPeer("192.168.1.255", boundary)).toBe(true);
    expect(isTrustedProxyPeer("192.168.2.0", boundary)).toBe(false);
  });

  test("a /0 entry matches every IPv4 address but no IPv6 address", () => {
    const boundary = trusted(["0.0.0.0/0"]);
    expect(isTrustedProxyPeer("8.8.8.8", boundary)).toBe(true);
    expect(isTrustedProxyPeer("0.0.0.0", boundary)).toBe(true);
    // Family is checked before the mask, so a v4 catch-all cannot leak into v6.
    expect(isTrustedProxyPeer("::1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("2001:db8::1", boundary)).toBe(false);
  });

  test("matches a /31 pair and rejects the next block", () => {
    const boundary = trusted(["127.0.0.1/31"]);
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.0", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.2", boundary)).toBe(false);
  });

  test("matches a /30 block and rejects the address just past it", () => {
    const boundary = trusted(["10.0.0.0/30"]);
    expect(isTrustedProxyPeer("10.0.0.3", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.4", boundary)).toBe(false);
  });

  test("a /32 entry matches only that address", () => {
    const boundary = trusted(["0.0.0.0/32"]);
    expect(isTrustedProxyPeer("0.0.0.0", boundary)).toBe(true);
    expect(isTrustedProxyPeer("0.0.0.1", boundary)).toBe(false);
  });

  test("accepts any entry in a multi-entry allowlist", () => {
    const boundary = trusted(["10.0.0.0/8", "127.0.0.1/32", "172.16.0.0/12"]);
    expect(isTrustedProxyPeer("10.1.2.3", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("172.16.5.5", boundary)).toBe(true);
    expect(isTrustedProxyPeer("192.168.1.1", boundary)).toBe(false);
  });
});

describe("isTrustedProxyPeer: IPv6 CIDR matching", () => {
  test("matches a compressed /128", () => {
    expect(isTrustedProxyPeer("::1", trusted(["::1/128"]))).toBe(true);
    expect(isTrustedProxyPeer("::2", trusted(["::1/128"]))).toBe(false);
  });

  test("matches a fully expanded spelling of a compressed entry", () => {
    // Both spellings are one address; a mismatch here would let an attacker
    // pick the spelling that misses the allowlist.
    expect(isTrustedProxyPeer("0:0:0:0:0:0:0:1", trusted(["::1/128"]))).toBe(true);
    expect(isTrustedProxyPeer("::1", trusted(["0:0:0:0:0:0:0:1/128"]))).toBe(true);
  });

  test("treats a bare IPv6 address as a /128", () => {
    expect(isTrustedProxyPeer("::1", trusted(["::1"]))).toBe(true);
    expect(isTrustedProxyPeer("::2", trusted(["::1"]))).toBe(false);
    expect(isTrustedProxyPeer("::1", trusted(["::"]))).toBe(false);
  });

  test("matches a /10 link-local range at both ends", () => {
    const boundary = trusted(["fe80::/10"]);
    expect(isTrustedProxyPeer("fe80::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("febf::1", boundary)).toBe(true);
    // fec0::/10 is the next block up; a /10 must stop before it.
    expect(isTrustedProxyPeer("fec0::1", boundary)).toBe(false);
  });

  test("matches a /32 documentation prefix and rejects its neighbour", () => {
    const boundary = trusted(["2001:db8::/32"]);
    expect(isTrustedProxyPeer("2001:db8::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("2001:db8:1234::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("2001:db9::1", boundary)).toBe(false);
  });

  test("matches an entry written in a longer form than the peer", () => {
    // `2001:0db8:0000::/32` and `2001:db8::1` are the same prefix.
    expect(isTrustedProxyPeer("2001:db8::1", trusted(["2001:0db8:0000::/32"]))).toBe(true);
  });

  test("a ::/0 entry matches every IPv6 address but no IPv4 address", () => {
    const boundary = trusted(["::/0"]);
    expect(isTrustedProxyPeer("::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("2001:db8::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("8.8.8.8", boundary)).toBe(false);
  });

  test("matches a /127 pair", () => {
    const boundary = trusted(["::1/127"]);
    expect(isTrustedProxyPeer("::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("::3", boundary)).toBe(false);
  });
});

describe("isTrustedProxyPeer: IPv4-mapped IPv6", () => {
  test("the dotted and hex spellings of a mapped loopback are the same host", () => {
    // Bun reports the loopback peer as `::ffff:127.0.0.1` on Windows while the
    // documented allowlist is `127.0.0.1/32`. Without unwrapping, the trust
    // check fails for the exact peer the allowlist exists to cover, forwarded
    // headers are ignored, and every proxied request stores the loopback.
    const boundary = LOOPBACK;
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("::ffff:7f00:1", boundary)).toBe(true);
  });

  test("mapped spellings agree with the plain IPv4 answer", () => {
    // Compared against the plain form rather than asserted in isolation, so a
    // change to the allowlist cannot make one spelling silently diverge.
    const plain = isTrustedProxyPeer("127.0.0.1", LOOPBACK);
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", LOOPBACK)).toBe(plain);
    expect(isTrustedProxyPeer("::ffff:7f00:1", LOOPBACK)).toBe(plain);
    expect(isTrustedProxyPeer("::FFFF:127.0.0.1", LOOPBACK)).toBe(plain);
  });

  test("a mapped address outside the allowlist stays untrusted", () => {
    // The unwrap must not become a blanket pass.
    expect(isTrustedProxyPeer("::ffff:198.51.100.9", LOOPBACK)).toBe(false);
  });

  test("a mapped peer matches a wider IPv4 range", () => {
    expect(isTrustedProxyPeer("::ffff:10.1.2.3", trusted(["10.0.0.0/8"]))).toBe(true);
  });

  test("a mapped allowlist entry matches a plain IPv4 peer", () => {
    // The unwrap is applied to the entry too, so the operator may write either
    // spelling of the same proxy.
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["::ffff:127.0.0.1/32"]))).toBe(true);
    expect(isTrustedProxyPeer("10.1.2.3", trusted(["::ffff:10.0.0.0/8"]))).toBe(true);
  });

  test("a mapped entry matches a mapped peer in either spelling", () => {
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", trusted(["::ffff:7f00:1/32"]))).toBe(true);
    expect(isTrustedProxyPeer("::ffff:7f00:1", trusted(["::ffff:127.0.0.1/32"]))).toBe(true);
  });

  test("an expanded mapped address is the same host as plain IPv4", () => {
    // DEFECT: `unwrapMappedIpv4` only recognizes the compressed `::ffff:` prefix.
    // `::ffff:127.0.0.1` and `::ffff:7f00:1` unwrap, but the expanded
    // `0:0:0:0:0:ffff:7f00:1` (the same address, written out) does not: the
    // prefix test fails, the value falls through to `ipv6ToBigInt`, and the
    // host is treated as an IPv6 address unrelated to `127.0.0.1`.
    //
    // Mechanism: `unwrapMappedIpv4` does `value.startsWith("::ffff:")`. Any
    // leading zero group (`0:0:0:0:0:ffff:...`) misses that test, so
    // `isTrustedProxyPeer` returns false for a peer the allowlist covers, and
    // `canonicalClientIpKey` yields `v6:…ffff7f000001` instead of
    // `v4:2130706433` — two keys for one host, which is what the
    // one-active-key-per-IP rule in the share router deduplicates on.
    //
    // Reachability: the peer string comes from `server.requestIP`, so a runtime
    // that reports the expanded form reintroduces the original bug this helper
    // was written to fix (a proxied request storing the loopback as the client).
    // No evidence a current runtime does; the dotted and hex compressed forms
    // are the ones observed, and both pass.
    const expanded = "0:0:0:0:0:ffff:7f00:1";
    expect(isTrustedProxyPeer(expanded, LOOPBACK)).toBe(
      isTrustedProxyPeer("127.0.0.1", LOOPBACK),
    );
  });

  test("an expanded mapped address canonicalizes to its IPv4 key", () => {
    // Same defect as above, observed on the database-key surface. The expanded
    // form keys as `v6:00000000000000000000ffff7f000001` while the plain and
    // compressed forms key as `v4:2130706433`, so a caller who reaches the
    // share-issue endpoint through a runtime reporting the expanded form gets a
    // second active key for one host instead of being refused.
    expect(canonicalClientIpKey("0:0:0:0:0:ffff:7f00:1")).toBe(canonicalClientIpKey("127.0.0.1"));
  });
});

describe("isTrustedProxyPeer: zone ids and malformed input", () => {
  test("a zone id does not change the match", () => {
    // A scoped link-local peer is the same interface as its unscoped form, so
    // dropping the `%zone` must not lose a legitimate proxy.
    expect(isTrustedProxyPeer("fe80::1%eth0", trusted(["fe80::/10"]))).toBe(true);
    expect(canonicalClientIpKey("fe80::1%eth0")).toBe(canonicalClientIpKey("fe80::1"));
  });

  test("a zone id on an IPv4 address is not an address", () => {
    // `%` is IPv6 scope syntax only; `isIP` rejects it on a v4 literal, so this
    // must fail closed rather than be trimmed into a match.
    expect(isTrustedProxyPeer("127.0.0.1%eth0", trusted(["0.0.0.0/0"]))).toBe(false);
    expect(canonicalClientIpKey("127.0.0.1%eth0")).toBeUndefined();
  });

  test("malformed and empty peers never match", () => {
    // Each of these is a string the boundary must reject outright rather than
    // coerce: a permissive parse of `1.2.3` or `010.0.0.1` would be a
    // different address than the operator wrote.
    const v4CatchAll = trusted(["0.0.0.0/0"]);
    for (const peer of ["", ":::", "1.2.3", "1.2.3.4.5", "010.0.0.1", "not-an-ip", " 127.0.0.1"]) {
      expect(isTrustedProxyPeer(peer, v4CatchAll)).toBe(false);
    }
    expect(isTrustedProxyPeer("not-an-ip", trusted(["::/0"]))).toBe(false);
  });

  test("a malformed CIDR entry never matches, and never widens the match", () => {
    // `10.0.0.0/` USED to parse as prefix 0 — a /0, every IPv4 address — because
    // `Number("")` is 0 and `""` is not `undefined`. That was the one leniency here
    // with a security shape, and it failed OPEN: any peer at all became a trusted
    // proxy, so the gateway believed the caller's own `X-Forwarded-For` and every
    // per-address decision downstream read a forged value.
    //
    // A blank or non-digit prefix is now refused outright, so the entry matches
    // nothing rather than everything.
    expect(isTrustedProxyPeer("8.8.8.8", trusted(["10.0.0.0/"]))).toBe(false);
    expect(isTrustedProxyPeer("8.8.8.8", trusted(["127.0.0.1/"]))).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", trusted(["10.0.0.0/"]))).toBe(false);

    // Out-of-range and non-numeric prefixes are rejected rather than clamped.
    expect(isTrustedProxyPeer("10.0.0.1", trusted(["10.0.0.0/33"]))).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", trusted(["10.0.0.0/-1"]))).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", trusted(["10.0.0.0/8abc"]))).toBe(false);
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["/32"]))).toBe(false);
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["not-a-cidr"]))).toBe(false);
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["127.0.0.1:80"]))).toBe(false);
  });

  test("an explicit /0 still trusts every peer of its own family", () => {
    // The deliberate act, kept distinct from the malformed spellings above.
    // MEASURED: a /0 is scoped to its FAMILY — the CIDR parser requires
    // `isIP(address) === isIP(network)` — so `::/0` trusts every IPv6 peer but not
    // an IPv4 one. I first asserted it trusted everything and was wrong.
    expect(isTrustedProxyPeer("8.8.8.8", trusted(["0.0.0.0/0"]))).toBe(true);
    expect(isTrustedProxyPeer("::1", trusted(["0.0.0.0/0"]))).toBe(false);
    expect(isTrustedProxyPeer("2001:db8::1", trusted(["::/0"]))).toBe(true);
    expect(isTrustedProxyPeer("8.8.8.8", trusted(["::/0"]))).toBe(false);
  });

  test("a trailing separator is ignored rather than treated as part of the address", () => {
    // `cidr.split("/")` keeps only the first two segments, so `127.0.0.1/32/32`
    // is read as `127.0.0.1/32`. Pinned so the behavior is a decision, not an
    // accident: it cannot widen the match beyond the address the operator wrote.
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["127.0.0.1/32/32"]))).toBe(true);
  });

  test("a whitespace-suffixed prefix still parses as that prefix", () => {
    // The padding is trimmed before the digits are read, so a stray space does not
    // disable the entry. This is the boundary of the fix: a padded number IS a run
    // of digits once trimmed, so it keeps working while the zero-coercion spellings
    // are refused.
    expect(isTrustedProxyPeer("10.0.0.1", trusted(["10.0.0.0/8 "]))).toBe(true);
    expect(isTrustedProxyPeer("10.128.0.1", trusted(["10.0.0.0/ 8"]))).toBe(true);
  });

  test("a prefix that is not a run of digits disables the entry", () => {
    // `Number` used to accept all of these. `8.0`, `1e1`, `0x8`, and `+8` are
    // integers that happen to mean /8, and `8.5`/`1e1x` are non-integers — but the
    // important one is that `0x0`, `0b0`, `0o0`, `-0`, and `0.0` all evaluated to
    // ZERO, which is a /0. Reading the prefix as digits removes the whole family
    // rather than trying to enumerate which spellings are safe.
    //
    // The unsafe direction is widening, and none of these widen now.
    for (const entry of ["10.0.0.0/8.0", "10.0.0.0/1e1", "10.0.0.0/0x8", "10.0.0.0/+8"]) {
      expect(isTrustedProxyPeer("10.0.0.1", trusted([entry]))).toBe(false);
    }
    for (const entry of ["10.0.0.0/8.5", "10.0.0.0/1e1x"]) {
      expect(isTrustedProxyPeer("10.0.0.1", trusted([entry]))).toBe(false);
    }
    // And the zero spellings specifically, which are the ones that widened.
    for (const entry of ["10.0.0.0/0x0", "10.0.0.0/0b0", "10.0.0.0/0o0", "10.0.0.0/-0", "10.0.0.0/0.0"]) {
      expect(isTrustedProxyPeer("8.8.8.8", trusted([entry]))).toBe(false);
    }
  });
});

describe("isTrustedProxyPeer: modes", () => {
  test("disabled mode trusts nothing, even with an allowlist present", () => {
    // The mode is the gate, not the allowlist: a leftover allowlist under
    // `disabled` must not re-enable forwarded-header trust.
    expect(isTrustedProxyPeer("127.0.0.1", DISABLED)).toBe(false);
    expect(isTrustedProxyPeer("127.0.0.1", { mode: "disabled", allowlist: ["127.0.0.1/32"] })).toBe(false);
  });

  test("platform mode trusts every peer, because it has no allowlist", () => {
    // The mode asserts the PaaS edge is the only way in; the peer carries no
    // information, so there is nothing to match.
    expect(isTrustedProxyPeer("10.1.2.3", PLATFORM)).toBe(true);
    expect(isTrustedProxyPeer("203.0.113.7", PLATFORM)).toBe(true);
  });

  test("trusted mode with no allowlist trusts nothing", () => {
    // `allowlist?.some(...) ?? false` — a missing list is not "match all".
    expect(isTrustedProxyPeer("127.0.0.1", { mode: "trusted" })).toBe(false);
    expect(isTrustedProxyPeer("127.0.0.1", trusted([]))).toBe(false);
  });

  test("an empty peer string matches no entry", () => {
    expect(isTrustedProxyPeer("", trusted(["0.0.0.0/0"]))).toBe(false);
    expect(isTrustedProxyPeer("", trusted(["/0"]))).toBe(false);
    // Platform mode is the documented exception: the peer is never consulted.
    expect(isTrustedProxyPeer("", PLATFORM)).toBe(true);
  });
});

describe("resolveClientIdentity", () => {
  test("an untrusted peer's forwarded headers are all ignored", () => {
    // The spoofing property. A caller reaching the gateway directly, outside
    // the allowlist, must not be able to name its own client address — that
    // address is the dimension the per-IP abuse limits are counted on.
    const untrusted = trusted(["10.0.0.0/8"]);
    const peer = "198.51.100.9";
    for (const name of ["cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"]) {
      expect(resolveClientIdentity(request({ [name]: "203.0.113.7" }), untrusted, peer)).toBe(peer);
      expect(resolveClientIdentity(request({ [name]: "203.0.113.7" }), DISABLED, peer)).toBe(peer);
    }
  });

  test("an untrusted peer's spoofed chain is ignored in full", () => {
    const headers = { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "cf-connecting-ip": "9.9.9.9" };
    expect(resolveClientIdentity(request(headers), DISABLED, "198.51.100.9")).toBe("198.51.100.9");
  });

  test("a trusted peer's header is honored", () => {
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
  });

  test("the single-valued edge headers outrank the forwarded chain", () => {
    // `CF-Connecting-IP` and `True-Client-IP` are overwritten by the edge, so
    // they cannot carry a caller-supplied value; the chain can.
    const headers = {
      "cf-connecting-ip": "203.0.113.7",
      "true-client-ip": "203.0.113.8",
      "x-forwarded-for": "1.1.1.1",
      "x-real-ip": "2.2.2.2",
    };
    expect(resolveClientIdentity(request(headers), LOOPBACK, "127.0.0.1")).toBe("203.0.113.7");
    const { "cf-connecting-ip": _cf, ...withoutCf } = headers;
    expect(resolveClientIdentity(request(withoutCf), LOOPBACK, "127.0.0.1")).toBe("203.0.113.8");
  });

  test("x-forwarded-for outranks x-real-ip", () => {
    const headers = { "x-forwarded-for": "203.0.113.9", "x-real-ip": "1.1.1.1" };
    expect(resolveClientIdentity(request(headers), LOOPBACK, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("a multi-hop chain resolves to its left end", () => {
    // cloudflared prepends the address it observed, so the left end is the
    // client. This is the assumption the loopback allowlist depends on.
    const headers = { "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" };
    expect(resolveClientIdentity(request(headers), LOOPBACK, "127.0.0.1")).toBe("203.0.113.7");
  });

  test("whitespace around a hop is trimmed", () => {
    expect(resolveClientIdentity(request({ "x-forwarded-for": "   203.0.113.7  " }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
  });

  test("empty segments are dropped rather than returned as the identity", () => {
    // A leading comma is what an appending edge produces when the caller sent
    // no chain at all; returning the empty string would store "" as a client
    // address and collapse every such caller into one identity.
    expect(resolveClientIdentity(request({ "x-forwarded-for": " , 203.0.113.7" }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
    expect(resolveClientIdentity(request({ "x-forwarded-for": " , " }), LOOPBACK, "127.0.0.1")).toBe("127.0.0.1");
  });

  test("an empty higher-priority header falls through to the next one", () => {
    const headers = { "cf-connecting-ip": "", "x-forwarded-for": "203.0.113.12" };
    expect(resolveClientIdentity(request(headers), LOOPBACK, "127.0.0.1")).toBe("203.0.113.12");
    const headers2 = { "x-forwarded-for": "", "x-real-ip": "203.0.113.11" };
    expect(resolveClientIdentity(request(headers2), LOOPBACK, "127.0.0.1")).toBe("203.0.113.11");
  });

  test("with no forwarded header at all the peer is the identity", () => {
    expect(resolveClientIdentity(request({}), LOOPBACK, "127.0.0.1")).toBe("127.0.0.1");
    expect(resolveClientIdentity(request({}), PLATFORM, "10.1.2.3")).toBe("10.1.2.3");
  });

  test("the selected value is not validated before it is stored", () => {
    // The edge is the trust boundary, so a trusted peer's value is taken as
    // given. Pinned so the contract is explicit: validation happens at
    // `canonicalClientIpKey`, which fails closed on these.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "not-an-ip" }), LOOPBACK, "127.0.0.1")).toBe(
      "not-an-ip",
    );
    expect(canonicalClientIpKey("not-an-ip")).toBeUndefined();
  });

  test("a mapped forwarded address is stored in canonical IPv4 form", () => {
    // One host must be one stored value, whichever spelling the edge forwarded.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "::ffff:203.0.113.7" }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "::ffff:cb00:7107" }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
  });

  test("an untrusted mapped peer is unwrapped for storage", () => {
    // The loopback Bun reports on Windows must not be stored as a v6 string, or
    // every directly-connected caller shares one identity.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), DISABLED, "::ffff:198.51.100.9")).toBe(
      "198.51.100.9",
    );
    expect(resolveClientIdentity(request({}), DISABLED, "::ffff:c633:6409")).toBe("198.51.100.9");
  });

  test("platform mode honors the chain, including a spoofed left end", () => {
    // Documented consequence of the mode: the peer carries no information, so
    // the chain is the only signal. The left end is taken as sent.
    expect(resolveClientIdentity(request({ "x-forwarded-for": "203.0.113.7" }), PLATFORM, "10.1.2.3")).toBe(
      "203.0.113.7",
    );
    expect(resolveClientIdentity(request({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }), PLATFORM, "10.1.2.3")).toBe(
      "1.2.3.4",
    );
  });

  test("disabled mode ignores the chain", () => {
    // This is the shape `resolveTrustedProxyBoundary` produces for `disabled`:
    // the mode alone, with no allowlist. The peer is the client.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), DISABLED, "127.0.0.1")).toBe(
      "127.0.0.1",
    );
    expect(resolveClientIdentity(request({ "x-forwarded-for": "203.0.113.7" }), DISABLED, "127.0.0.1")).toBe(
      "127.0.0.1",
    );
  });

  test("disabled mode ignores the chain even when an allowlist is present", () => {
    // DEFECT: `resolveClientIdentity` gates on `isTrustedPeer`, not on
    // `isTrustedProxyPeer`. The two differ by exactly one term — the latter is
    // `mode !== "disabled" && isTrustedPeer(...)` — so a boundary that carries
    // both `disabled` and an allowlist is honored by this function and refused
    // by `isTrustedProxyPeer`. The module then holds two contradictory answers
    // to "is this peer trusted?" for the same peer.
    //
    // Mechanism: `resolveClientIdentity` reaches the header loop whenever the
    // allowlist matches, because `isTrustedPeer` never consults `mode` unless
    // it is `platform`. So `{ mode: "disabled", allowlist: ["127.0.0.1/32"] }`
    // ignores `mode` entirely and honors `cf-connecting-ip`.
    //
    // This contradicts the doc comment directly: "`disabled` (default) always
    // trusts the raw TCP peer", and `config.ts` — "`disabled` — the raw TCP
    // peer is the client; forwarded headers are ignored". The security
    // consequence is the spoofing property: a caller able to reach the port
    // would name its own client address, which is the dimension the per-IP
    // abuse limits are counted on, and would get a different answer from
    // `securePolicyForRequest` (which does use `isTrustedProxyPeer`) in the
    // same request.
    //
    // Reachability: latent. `resolveTrustedProxyBoundary` returns a bare
    // `{ mode: "disabled" }` when `TRUSTED_PROXY_CIDRS` is unset, and
    // `console-router.ts` defaults the same way, so the current config path
    // cannot produce the failing shape. It is reachable for any caller that
    // constructs a boundary by hand, and it is one config edit from being live.
    const boundary: TrustedProxyBoundary = { mode: "disabled", allowlist: ["127.0.0.1/32"] };
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(false);
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), boundary, "127.0.0.1")).toBe(
      "127.0.0.1",
    );
  });
});

describe("canonicalClientIpKey", () => {
  test("tags IPv4 by family and value", () => {
    expect(canonicalClientIpKey("127.0.0.1")).toBe("v4:2130706433");
    expect(canonicalClientIpKey("0.0.0.0")).toBe("v4:0");
    expect(canonicalClientIpKey("255.255.255.255")).toBe("v4:4294967295");
    expect(canonicalClientIpKey("203.0.113.7")).toBe("v4:3405803783");
  });

  test("gives one host one key across every IPv4-mapped spelling", () => {
    // The per-IP rule is enforced on this key, so two keys for one host is two
    // allowances for one host.
    const expected = "v4:2130706433";
    expect(canonicalClientIpKey("127.0.0.1")).toBe(expected);
    expect(canonicalClientIpKey("::ffff:127.0.0.1")).toBe(expected);
    expect(canonicalClientIpKey("::ffff:7f00:1")).toBe(expected);
    expect(canonicalClientIpKey("::FFFF:7F00:1")).toBe(expected);
  });

  test("a mapped key equals the plain IPv4 key for the same host", () => {
    expect(canonicalClientIpKey("::ffff:cb00:7107")).toBe(canonicalClientIpKey("203.0.113.7"));
    expect(canonicalClientIpKey("::ffff:192.168.0.1")).toBe(canonicalClientIpKey("192.168.0.1"));
  });

  test("normalizes IPv6 to a fixed-width lowercase hex key", () => {
    // Fixed width keeps the key a stable sort/compare dimension and keeps the
    // column one size; lowercase keeps two spellings from hashing apart.
    const compressed = canonicalClientIpKey("2001:db8::1");
    expect(compressed).toBe("v6:20010db8000000000000000000000001");
    expect(compressed).toHaveLength(3 + 32);
    expect(canonicalClientIpKey("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(compressed);
  });

  test("collapses alternate IPv6 spellings of loopback and unspecified", () => {
    expect(canonicalClientIpKey("::1")).toBe(canonicalClientIpKey("0:0:0:0:0:0:0:1"));
    expect(canonicalClientIpKey("::1")).toBe("v6:00000000000000000000000000000001");
    expect(canonicalClientIpKey("::")).toBe("v6:00000000000000000000000000000000");
  });

  test("keeps the families apart", () => {
    // `::ffff:0:1` unwraps to IPv4 0.0.0.1 while the IPv6 literal `::1` stays
    // v6; the tag is what keeps them from colliding.
    expect(canonicalClientIpKey("::ffff:0:1")).toBe(canonicalClientIpKey("0.0.0.1"));
    expect(canonicalClientIpKey("::1")).not.toBe(canonicalClientIpKey("0.0.0.1"));
  });

  test("one host gets one key across every mapped spelling", () => {
    // The defect this pins: `unwrapMappedIpv4` tested `startsWith("::ffff:")`, so
    // any form that writes the leading zero groups out missed the prefix test, fell
    // through to `ipv6ToBigInt`, and was treated as an unrelated IPv6 address. One
    // host then held TWO keys — which is what the one-active-key-per-IP rule in the
    // share router deduplicates on, so a caller reaching the endpoint through a
    // runtime reporting the expanded form got a second active key instead of being
    // refused.
    //
    // The mapped range is now recognized structurally, by normalizing to eight
    // 16-bit groups first. That is the only way to compare spellings: a dotted tail
    // is written as ONE colon-separated token but occupies TWO group slots, so any
    // check that counts `split(":")` entries mislocates the `ffff` marker.
    const plain = canonicalClientIpKey("127.0.0.1");
    expect(plain).toBe("v4:2130706433");
    for (const spelling of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::FFFF:7F00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "0:0:0:0:0:ffff:127.0.0.1",
    ]) {
      expect(canonicalClientIpKey(spelling)).toBe(plain);
    }
  });

  test("an address that only LOOKS mapped is left as IPv6", () => {
    // MEASURED: `::ffff:0:7f00:1` expands to `0:0:0:0:ffff:0:7f00:1` — the sixth
    // group is `0`, not `ffff`, so this is NOT an IPv4-mapped address. It is a
    // different host and must keep a different key. I first listed it as a mapped
    // spelling and was wrong; the structural check caught it.
    expect(canonicalClientIpKey("::ffff:0:7f00:1")).toBe(
      "v6:0000000000000000ffff00007f000001",
    );
    expect(canonicalClientIpKey("::ffff:0:7f00:1")).not.toBe(canonicalClientIpKey("127.0.0.1"));
  });

  test("the same collapse holds for a non-loopback mapped host", () => {
    // The loopback is the case the helper was written for; this is the general
    // property, so the fix is not loopback-specific.
    const plain = canonicalClientIpKey("203.0.113.7");
    for (const spelling of [
      "::ffff:203.0.113.7",
      "::ffff:cb00:7107",
      "0:0:0:0:0:ffff:cb00:7107",
    ]) {
      expect(canonicalClientIpKey(spelling)).toBe(plain);
    }
  });

  test("rejects invalid input instead of coercing it", () => {
    // The share router turns `undefined` into a 400 rather than minting a key,
    // so a permissive parse here would silently authorize the request.
    for (const address of [
      "",
      "not-an-ip",
      "1.2.3",
      "1.2.3.4.5",
      "010.0.0.1",
      " 127.0.0.1",
      "127.0.0.1 ",
      ":::",
      "::ffff:",
      "::ffff:1.2.3",
      "::ffff:256.0.0.1",
      "::ffff:zzzz:1",
      "::ffff:12345:1",
      "127.0.0.1%eth0",
    ]) {
      expect(canonicalClientIpKey(address)).toBeUndefined();
    }
  });

  test("a hex group with trailing junk is refused, not coerced", () => {
    // This used to be lenient: `parseInt("7f00z", 16)` is 0x7f00, so a group with
    // trailing junk unwrapped and keyed as 127.0.0.1, and `+`/space were accepted by
    // the same path. That made an invalid string share a key with a valid host.
    //
    // The normalization now requires each group to match `^[0-9a-f]{1,4}$`, so the
    // dotted and hex forms are equally strict. This is the fail-closed direction on
    // an input that can only come from a peer or a trusted edge.
    expect(canonicalClientIpKey("::ffff:7f00z:1")).toBeUndefined();
    expect(canonicalClientIpKey("::ffff:7f00:+1")).toBeUndefined();
    expect(canonicalClientIpKey("::ffff:7f00: 1")).toBeUndefined();
    expect(canonicalClientIpKey("::ffff:1.2.3.4.5")).toBeUndefined();
  });
});
