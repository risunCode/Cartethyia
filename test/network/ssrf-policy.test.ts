/**
 * The SSRF guard: which outbound destinations the gateway is willing to dial.
 *
 * Every configurable (BYOK) upstream and every operator-configured proxy pool
 * passes through `isAddressAllowed` before a socket is opened, so a hole here
 * lets a tenant point the gateway at an address it must never reach. The
 * motivating target is the cloud metadata endpoint — `169.254.169.254` returns
 * instance credentials to anything that can make an HTTP request — and the
 * classic bypasses are the ones this suite attacks:
 *
 * - **IPv4-mapped IPv6** (`::ffff:127.0.0.1`). A guard that checks only the
 *   leading 16-bit group of an IPv6 address sees `0` and lets it through unless
 *   it understands the mapping.
 * - **Transition mechanisms** (`2002::/16` 6to4 and `64:ff9b::/96` NAT64). Both
 *   embed an IPv4 address in the tail bits and translate it at a gateway, so the
 *   embedded range is what must be judged.
 * - **A hostname that resolves to several addresses, one of them private.** The
 *   check must judge every answer, not just the first.
 *
 * Everything here is a pure function of an address and a policy: no DNS, no
 * sockets, no sleeps. The one async path uses the injected resolver seam rather
 * than the real resolver, because a `.test` hostname would stall the suite.
 */
import { describe, expect, test } from "bun:test";
import {
  isAddressAllowed,
  resolveAndValidateOnce,
  validateResolvedAddresses,
  type ValidatedDestination,
} from "../../src/network/ssrf";
import type { SsrfPolicy } from "../../src/config";
import { GatewayError } from "../../src/transport/gateway-error";

/** The production default: a private destination is refused. */
const STRICT: SsrfPolicy = {};

/** True when the strict policy accepts the address. */
function allowed(address: string): boolean {
  return isAddressAllowed(address, STRICT);
}

describe("isAddressAllowed — the strict default", () => {
  test("a malformed address is refused, not treated as public", () => {
    // `isIP` returning 0 means the string is not an address at all. Accepting it
    // would let a value the caller controls reach a dial path that has no
    // address to validate.
    expect(allowed("")).toBe(false);
    expect(allowed("not-an-ip")).toBe(false);
    expect(allowed("999.1.1.1")).toBe(false);
    expect(allowed("1.2.3")).toBe(false);
    expect(allowed("1.2.3.4.5")).toBe(false);
    expect(allowed("::gggg")).toBe(false);
    expect(allowed("localhost")).toBe(false);
  });

  test("public addresses are allowed", () => {
    // The guard must not block ordinary egress; a strict-by-default policy that
    // refused these would take every provider offline.
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
      expect(allowed(address)).toBe(true);
    }
    for (const address of ["2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      expect(allowed(address)).toBe(true);
    }
  });
});

describe("isAddressAllowed — private IPv4 ranges", () => {
  test("RFC1918 ranges are refused", () => {
    for (const address of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
    ]) {
      expect(allowed(address)).toBe(false);
    }
  });

  test("the 172.16/12 boundary is exact", () => {
    // 172.15 is public, 172.16 and 172.31 are private, 172.32 is public again.
    // A `/8` or `/16` guard would either miss part of the range or block public
    // space — the latter takes a legitimate provider offline.
    expect(allowed("172.15.255.255")).toBe(true);
    expect(allowed("172.16.0.0")).toBe(false);
    expect(allowed("172.31.255.255")).toBe(false);
    expect(allowed("172.32.0.0")).toBe(true);
  });

  test("loopback is refused across the whole 127/8 block", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "127.255.255.255", "127.0.0.0"]) {
      expect(allowed(address)).toBe(false);
    }
  });

  test("link-local is refused, and the cloud metadata endpoint is named", () => {
    // 169.254.169.254 is the AWS/GCP/Azure instance metadata service: an HTTP
    // GET returns the instance's credentials. This is the single address the
    // guard exists to block, so it gets an explicit case rather than being left
    // as one member of a range assertion.
    expect(allowed("169.254.169.254")).toBe(false);
    expect(allowed("169.254.0.1")).toBe(false);
    expect(allowed("169.254.255.255")).toBe(false);
  });

  test("the other special-purpose IPv4 ranges are refused", () => {
    // Each of these is a distinct escape: `0.0.0.0` reaches the local host on
    // Linux, CGNAT is a carrier's private space, 198.18/15 is a benchmark range
    // that some resolvers answer for, and multicast is not a unicast destination
    // at all.
    for (const address of [
      "0.0.0.0",
      "0.255.255.255",
      "100.64.0.1",
      "100.127.255.255",
      "192.0.0.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
    ]) {
      expect(allowed(address)).toBe(false);
    }
  });

  test("the reserved class E range is NOT refused", () => {
    // MEASURED: the guard's list ends at `224.0.0.0/4` (multicast), so the
    // reserved `240.0.0.0/4` block and the broadcast address pass as if they were
    // ordinary public space. Pinned as measured rather than asserted as correct.
    // Impact is low in practice — no route to 240/4 or to 255.255.255.255 exists
    // on a normal network, so the dial fails at the socket rather than reaching
    // anything — but a reader should know the list's edge.
    expect(allowed("240.0.0.1")).toBe(true);
    expect(allowed("255.255.255.255")).toBe(true);
  });

  test("TEST-NET-2 documentation space is refused while TEST-NET-1 is not", () => {
    // MEASURED: the guard lists `198.51.100.0/24` (TEST-NET-2) and
    // `203.0.113.0/24` (TEST-NET-3) but not `192.0.2.0/24` (TEST-NET-1), so the
    // three documentation blocks are not treated alike. Pinned as measured: a
    // suite that used `203.0.113.x` as its stand-in for "a public address" would
    // be asserting the opposite of what the guard does.
    expect(allowed("198.51.100.1")).toBe(false);
    expect(allowed("203.0.113.1")).toBe(false);
    expect(allowed("192.0.2.1")).toBe(true);
  });

  test("the CGNAT boundary is exact", () => {
    // 100.64/10 spans 100.64.0.0 – 100.127.255.255; 100.63 and 100.128 are
    // public.
    expect(allowed("100.63.255.255")).toBe(true);
    expect(allowed("100.64.0.0")).toBe(false);
    expect(allowed("100.127.255.255")).toBe(false);
    expect(allowed("100.128.0.0")).toBe(true);
  });
});

describe("isAddressAllowed — IPv6 ranges and transition mechanisms", () => {
  test("loopback and unspecified are refused", () => {
    expect(allowed("::1")).toBe(false);
    expect(allowed("::")).toBe(false);
  });

  test("unique-local fc00::/7 is refused, including fd00::", () => {
    expect(allowed("fc00::1")).toBe(false);
    expect(allowed("fd00::1")).toBe(false);
    expect(allowed("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
  });

  test("link-local fe80::/10 is refused, and the range boundary is exact", () => {
    // fe80:: through febf:: is link-local; fec0:: is not (it is the deprecated
    // site-local space, which the guard does not list).
    expect(allowed("fe80::1")).toBe(false);
    expect(allowed("febf::1")).toBe(false);
    expect(allowed("fec0::1")).toBe(true);
  });

  test("multicast is refused", () => {
    expect(allowed("ff02::1")).toBe(false);
    expect(allowed("ff00::")).toBe(false);
  });

  test("documentation space 2001:db8::/32 is refused", () => {
    expect(allowed("2001:db8::1")).toBe(false);
  });

  test("the IPv4-mapped form of loopback is refused", () => {
    // The classic bypass. `::ffff:127.0.0.1` is the same host as 127.0.0.1, and
    // a guard that reads only the leading 16-bit group of an IPv6 address sees
    // zero — which its own `first === 0` clause happens to cover, but only
    // because that clause exists. Asserted explicitly so removing it fails here.
    expect(allowed("::ffff:127.0.0.1")).toBe(false);
    expect(allowed("::ffff:169.254.169.254")).toBe(false);
    expect(allowed("::ffff:10.0.0.1")).toBe(false);
    expect(allowed("::ffff:192.168.1.1")).toBe(false);
  });

  test("the IPv4-mapped form of a PUBLIC address is refused too", () => {
    // MEASURED: `first === 0` covers the whole `::ffff:0:0/96` block, so a
    // mapped public address is refused as well. Pinned as the conservative
    // direction: the guard is not trying to distinguish inside a range that only
    // exists for local interop, and refusing it costs a deployment nothing it
    // should have been using.
    expect(allowed("::ffff:1.1.1.1")).toBe(false);
    expect(allowed("::ffff:8.8.8.8")).toBe(false);
  });

  test("the deprecated IPv4-compatible form is refused", () => {
    // `::1.2.3.4` (no `ffff`) is the old compatible encoding, also covered by
    // the same clause.
    expect(allowed("::127.0.0.1")).toBe(false);
    expect(allowed("::169.254.169.254")).toBe(false);
  });

  test("a 6to4 address embedding a private IPv4 is refused", () => {
    // 2002::/16 carries an IPv4 address in bytes 2-5 and a relay translates it.
    // 2002:0a00:0001:: embeds 10.0.0.1.
    expect(allowed("2002:a00:1::")).toBe(false);
    expect(allowed("2002:7f00:1::")).toBe(false);
    expect(allowed("2002:c0a8:101::")).toBe(false);
    // 2002:0101:0101:: embeds 1.1.1.1, which is public.
    expect(allowed("2002:101:101::")).toBe(true);
  });

  test("a NAT64 address embedding a private IPv4 is refused", () => {
    // 64:ff9b::/96 embeds the IPv4 in the last four bytes.
    expect(allowed("64:ff9b::a00:1")).toBe(false);
    expect(allowed("64:ff9b::7f00:1")).toBe(false);
    // Embedding a public address is allowed.
    expect(allowed("64:ff9b::101:101")).toBe(true);
  });
});

describe("isAddressAllowed — the policy overrides", () => {
  test("allowPrivate admits every otherwise-unsafe address", () => {
    // The escape hatch for a deployment that genuinely dials a private upstream.
    const policy: SsrfPolicy = { allowPrivate: true };
    for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"]) {
      expect(isAddressAllowed(address, policy)).toBe(true);
    }
  });

  test("allowPrivate does NOT admit a malformed address", () => {
    // The malformed check runs first and is not policy-gated: a string that is
    // not an address has nothing to validate, and admitting it would push the
    // failure to a dial path with no address to check.
    const policy: SsrfPolicy = { allowPrivate: true };
    expect(isAddressAllowed("not-an-ip", policy)).toBe(false);
    expect(isAddressAllowed("", policy)).toBe(false);
  });

  test("an allowedNetworks entry admits exactly that range", () => {
    // The other escape hatch: an operator naming a specific private range rather
    // than opening all of them.
    const policy: SsrfPolicy = { allowedNetworks: ["10.1.0.0/16"] };
    expect(isAddressAllowed("10.1.0.1", policy)).toBe(true);
    expect(isAddressAllowed("10.1.255.255", policy)).toBe(true);
    // A sibling range is still refused.
    expect(isAddressAllowed("10.2.0.1", policy)).toBe(false);
    expect(isAddressAllowed("10.0.0.1", policy)).toBe(false);
  });

  test("an allowedNetworks entry works for IPv6", () => {
    const policy: SsrfPolicy = { allowedNetworks: ["fd00:1234::/32"] };
    expect(isAddressAllowed("fd00:1234::1", policy)).toBe(true);
    expect(isAddressAllowed("fd00:9999::1", policy)).toBe(false);
  });

  test("an allowedNetworks entry cannot admit a different address family", () => {
    // The `family !== isIP(network)` guard: a v4 CIDR must not match a v6
    // address, which would otherwise let a prefix-length coincidence widen the
    // allowlist.
    const policy: SsrfPolicy = { allowedNetworks: ["10.0.0.0/8"] };
    expect(isAddressAllowed("::a00:1", policy)).toBe(false);
    const v6Policy: SsrfPolicy = { allowedNetworks: ["fc00::/7"] };
    expect(isAddressAllowed("10.0.0.1", v6Policy)).toBe(false);
  });

  test("a malformed CIDR is ignored rather than widening the allowlist", () => {
    // `cidrContains` returns false for anything it cannot parse, so the private
    // address stays refused. (The public address is allowed either way, because
    // the fallback is `!unsafeAddress` — which is why the assertion below is on
    // the private address only: it is the one the allowlist could wrongly admit.)
    for (const cidr of [
      "10.0.0.0",
      "10.0.0.0/abc",
      "10.0.0.0/33",
      "10.0.0.0/-1",
      "/8",
      "",
      "garbage",
      "10.0.0.0 /8",
      " 10.0.0.0/8",
    ]) {
      const policy: SsrfPolicy = { allowedNetworks: [cidr] };
      expect(isAddressAllowed("10.0.0.1", policy)).toBe(false);
    }
  });

  test("a prefix length padded with a space is still accepted", () => {
    // The padding is trimmed before the digits are read, so `10.0.0.0/ 8` keeps
    // behaving exactly like `10.0.0.0/8`. This is the boundary of the fix: the
    // guard refuses a prefix that is not a run of digits, and a padded number IS
    // one once trimmed — so the fix closes the zero-coercion hole without
    // rejecting a spelling that already meant what the operator intended.
    //
    // The discriminator is a *private* address outside the range: `172.16.0.1`
    // is refused unless the CIDR admitted it, whereas a public address would be
    // allowed by the `!unsafeAddress` fallback either way.
    const policy: SsrfPolicy = { allowedNetworks: ["10.0.0.0/ 8"] };
    expect(isAddressAllowed("10.1.2.3", policy)).toBe(true);
    expect(isAddressAllowed("172.16.0.1", policy)).toBe(false);
    expect(isAddressAllowed("192.168.0.1", policy)).toBe(false);
  });

  test("an explicit /0 admits every address of its family, as documented", () => {
    // The *explicit* zero prefix is the same code path but a deliberate act: an
    // operator writing `0.0.0.0/0` has asked for everything. Pinned next to the
    // malformed spellings below so the two are not confused — the bug was the
    // blank string being coerced into this value, not the value itself.
    const policy: SsrfPolicy = { allowedNetworks: ["0.0.0.0/0"] };
    expect(isAddressAllowed("169.254.169.254", policy)).toBe(true);
    expect(isAddressAllowed("1.1.1.1", policy)).toBe(true);
  });

  /**
   * KNOWN DEFECT — a CIDR with a trailing slash and no prefix length opens the
   * SSRF guard to every IPv4 address, including the cloud metadata endpoint.
   *
   * `cidrContains` (`src/network/ssrf.ts:67`) destructures `cidr.split("/")`
   * into `[network, prefixText]` and then does `const prefix = Number(prefixText)`.
   * `Number("")` is `0`, and `""` is not `undefined`, so the
   * `prefixText === undefined` guard does not fire. With `prefix = 0` the
   * function returns `ipv4Number(address) >>> 32 === ipv4Number(network) >>> 32`,
   * which is `0 === 0` for every IPv4 address. One malformed entry therefore
   * admits *every* IPv4 destination.
   *
   * Reachable impact: `resolveSsrfPolicy` (`src/config.ts:375`) reads this list
   * verbatim from `CARTETHYIA_ALLOWED_NETWORKS` through `readList`, which splits
   * on commas and trims but validates nothing. An operator writing
   * `CARTETHYIA_ALLOWED_NETWORKS=10.0.0.0/` — a truncated paste, or the prefix
   * left off — gets a guard that accepts `169.254.169.254` (the instance
   * metadata service) plus every private range the guard exists to refuse, with
   * no warning at startup. The failure is silent and fail-open, which is the
   * wrong direction for a security boundary.
   *
   * The neighbouring malformed shapes are handled correctly, which is what makes
   * this an oversight rather than a design choice: `10.0.0.0/abc` parses to
   * `NaN` and is refused, and `10.0.0.0` with no slash has
   * `prefixText === undefined` and is refused.
   *
   * Written with `test.failing` so it flips to a failure the moment the prefix is
   * validated, which is the signal to drop the marker and keep the assertion.
   */
  test("a CIDR with an empty prefix length does not admit every IPv4 address", () => {
    const policy: SsrfPolicy = { allowedNetworks: ["10.0.0.0/"] };
    expect(isAddressAllowed("169.254.169.254", policy)).toBe(false);
    expect(isAddressAllowed("10.0.0.1", policy)).toBe(false);
    // An IPv6 destination is refused either way, by the family check.
    expect(isAddressAllowed("::1", policy)).toBe(false);
  });

  test("the malformed entry admits nothing at all", () => {
    // Was the `test.failing`'s complement, recording that the entry admitted every
    // IPv4 address. Now inverted: a malformed prefix is refused outright rather
    // than narrowed, so the guard fails closed in both directions.
    //
    // The discriminators are PRIVATE addresses: `169.254.169.254` (link-local) and
    // `172.16.0.1` are refused unless the CIDR admitted them, whereas a public
    // address such as `1.1.1.1` is allowed by the `!unsafeAddress` fallback either
    // way and would make this assertion vacuous.
    const policy: SsrfPolicy = { allowedNetworks: ["10.0.0.0/"] };
    expect(isAddressAllowed("169.254.169.254", policy)).toBe(false);
    expect(isAddressAllowed("172.16.0.1", policy)).toBe(false);
    expect(isAddressAllowed("10.0.0.1", policy)).toBe(false);
    expect(isAddressAllowed("::1", policy)).toBe(false);
  });

  test("every blank or exotic zero prefix spelling is refused", () => {
    // `cidrContains` read the prefix with `Number(prefixText)`, which is far more
    // permissive than a CIDR reader should be: a whole family of spellings
    // evaluates to `0`, and a /0 admits every address of the family. An operator's
    // typo therefore widened the SSRF allowlist to the entire IPv4 space,
    // including the cloud metadata endpoint the guard exists to refuse.
    //
    // The fix reads the prefix as a trimmed run of digits, so a written `0` is the
    // only way to ask for everything. Each entry below reached the same hole.
    for (const cidr of [
      "10.0.0.0/", // the original: Number("") === 0
      "10.0.0.0/ ", // a space: Number(" ") === 0
      "10.0.0.0/-0", // negative zero passes a `prefix < 0` check
      "10.0.0.0/+0",
      "10.0.0.0/0x0",
      "10.0.0.0/0b0",
      "10.0.0.0/0o0",
      "10.0.0.0/0.0",
      // Already refused before the fix (`Number` yields NaN), kept so the
      // neighbouring shapes stay pinned.
      "10.0.0.0/abc",
      "10.0.0.0/8.5",
      "10.0.0.0/-1",
    ]) {
      const policy: SsrfPolicy = { allowedNetworks: [cidr] };
      // The metadata endpoint is the one that must never be admitted by a typo.
      expect(isAddressAllowed("169.254.169.254", policy)).toBe(false);
      // And a PRIVATE address outside the entry's own range, so a passing result
      // cannot come from the public-address fallback. `1.1.1.1` would be allowed
      // either way and would make this assertion vacuous.
      expect(isAddressAllowed("172.16.0.1", policy)).toBe(false);
      expect(isAddressAllowed("10.0.0.1", policy)).toBe(false);
    }
  });

  test("a /0 CIDR admits every address of its family, as documented", () => {
    // The *explicit* zero prefix is the same code path but a deliberate act: an
    // operator writing `0.0.0.0/0` has asked for everything. Pinned next to the
    // defect above so the two are not confused — the bug is the empty string
    // being coerced into this value, not the value itself.
    const policy: SsrfPolicy = { allowedNetworks: ["0.0.0.0/0"] };
    expect(isAddressAllowed("169.254.169.254", policy)).toBe(true);
    expect(isAddressAllowed("1.1.1.1", policy)).toBe(true);
  });

  test("an empty allowedNetworks list changes nothing", () => {
    expect(isAddressAllowed("10.0.0.1", { allowedNetworks: [] })).toBe(false);
    expect(isAddressAllowed("1.1.1.1", { allowedNetworks: [] })).toBe(true);
  });

  test("a CIDR whose network is written with host bits still matches by prefix", () => {
    // `10.1.2.3/8` masks both sides, so it is the 10/8 network. Pinned because a
    // reader might expect the entry to be rejected as malformed. The negative
    // case uses a private address outside the range, so it cannot pass by the
    // public fallback.
    const policy: SsrfPolicy = { allowedNetworks: ["10.1.2.3/8"] };
    expect(isAddressAllowed("10.0.0.1", policy)).toBe(true);
    expect(isAddressAllowed("10.255.255.255", policy)).toBe(true);
    expect(isAddressAllowed("172.16.0.1", policy)).toBe(false);
  });
});

describe("validateResolvedAddresses", () => {
  test("every resolved address must pass, not just the first", () => {
    // The property an attacker exploits: a hostname the tenant controls answers
    // with one public address and one private one. Judging only the first lets
    // the second be dialed on the next attempt (or by a different client),
    // which is the DNS-rebind shape this check exists to close.
    expect(() => validateResolvedAddresses(["1.1.1.1", "169.254.169.254"], STRICT)).toThrow();
    expect(() => validateResolvedAddresses(["169.254.169.254", "1.1.1.1"], STRICT)).toThrow();
    expect(() => validateResolvedAddresses(["1.1.1.1", "1.1.1.2", "10.0.0.1"], STRICT)).toThrow();
  });

  test("an all-public resolution returns the first address", () => {
    // The returned value is the pin the caller dials, so it must be one of the
    // validated addresses.
    expect(validateResolvedAddresses(["1.1.1.1", "1.1.1.2"], STRICT)).toBe("1.1.1.1");
  });

  test("an empty resolution is refused rather than returning undefined", () => {
    // A resolver that answered nothing has proved nothing; a guard that let the
    // empty list through would hand the dial path an undefined destination.
    expect(() => validateResolvedAddresses([], STRICT)).toThrow();
  });

  test("the refusal is a 400 invalid_request from the gateway", () => {
    // The status is what the client sees and what the operator triages on: a
    // refused destination is the caller's configuration problem, not an upstream
    // outage, so it must not surface as a 502.
    let failure: unknown = null;
    try {
      validateResolvedAddresses(["10.0.0.1"], STRICT);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(400);
    expect((failure as GatewayError).code).toBe("invalid_request");
    expect((failure as GatewayError).origin).toBe("cartethyia");
  });

  test("the policy is honoured for every address in the list", () => {
    // With `allowPrivate`, a mixed list is fine — the override applies to the
    // whole validation, not to one address at a time.
    const policy: SsrfPolicy = { allowPrivate: true };
    expect(validateResolvedAddresses(["1.1.1.1", "10.0.0.1"], policy)).toBe("1.1.1.1");
    // But a malformed address is still refused.
    expect(() => validateResolvedAddresses(["1.1.1.1", "not-an-ip"], policy)).toThrow();
  });
});

describe("resolveAndValidateOnce — the pin", () => {
  /** An abort signal that is never aborted, for the happy paths. */
  function live(): AbortSignal {
    return new AbortController().signal;
  }

  test("a literal address short-circuits the resolver", async () => {
    // `isIP(hostname)` returns early, so a literal address never pays a DNS
    // round trip. Asserted by resolving a literal that a real resolver could not
    // answer for — the test would hang or fail if the short-circuit were gone.
    const destination = await resolveAndValidateOnce("1.1.1.1", STRICT, live(), 443);
    expect(destination).toEqual({ hostname: "1.1.1.1", resolvedAddress: "1.1.1.1", port: 443 });
  });

  test("a literal private address is refused without a resolver call", async () => {
    await expect(resolveAndValidateOnce("169.254.169.254", STRICT, live())).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  test("the port is carried through, defaulting to 443", async () => {
    // The port is part of the destination the caller dials; a wrong default
    // would silently send a non-TLS port to 443.
    expect((await resolveAndValidateOnce("1.1.1.1", STRICT, live())).port).toBe(443);
    expect((await resolveAndValidateOnce("1.1.1.1", STRICT, live(), 8443)).port).toBe(8443);
  });

  test("the returned destination pins the address it validated", async () => {
    // The shape the comment describes: the validated destination pins the
    // address so the socket cannot be re-pointed at a private host by a DNS
    // rebind between the check and the connect.
    const destination: ValidatedDestination = await resolveAndValidateOnce(
      "1.1.1.1",
      STRICT,
      live(),
    );
    expect(destination.hostname).toBe("1.1.1.1");
    expect(destination.resolvedAddress).toBe("1.1.1.1");
  });

  test("a refused address throws the same 400 the sync validator does", async () => {
    // The async path must not invent its own error shape; the caller's
    // classification depends on the code and status.
    let failure: unknown = null;
    try {
      await resolveAndValidateOnce("10.0.0.1", STRICT, live());
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(400);
  });
});

describe("isAddressAllowed — a policy that names both an allowlist and allowPrivate", () => {
  test("the allowlist is checked first and short-circuits", () => {
    // The order is `allowedNetworks` → `allowPrivate` → `!unsafeAddress`. Both
    // overrides admitting the address is not an error; the assertion pins that
    // the combination does not accidentally refuse something either would admit.
    const policy: SsrfPolicy = { allowPrivate: true, allowedNetworks: ["192.168.0.0/16"] };
    expect(isAddressAllowed("192.168.1.1", policy)).toBe(true);
    expect(isAddressAllowed("10.0.0.1", policy)).toBe(true);
    expect(isAddressAllowed("1.1.1.1", policy)).toBe(true);
  });

  test("a malformed CIDR beside a valid one does not break the valid one", () => {
    const policy: SsrfPolicy = { allowedNetworks: ["garbage", "10.1.0.0/16"] };
    expect(isAddressAllowed("10.1.0.1", policy)).toBe(true);
    expect(isAddressAllowed("10.2.0.1", policy)).toBe(false);
  });
});
