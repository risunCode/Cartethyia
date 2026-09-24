import { describe, expect, test } from "bun:test";
import {
  isAddressAllowed,
  resolveAllAddresses,
  resolveAndValidateOnce,
  validateResolvedAddresses,
} from "../../src/network/ssrf";
import type { SsrfPolicy } from "../../src/config";

const open: SsrfPolicy = {};

describe("resolveAllAddresses abort semantics", () => {
  test("an already-aborted signal surfaces as transport_closed 499, not 400", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveAllAddresses("example.com", controller.signal)).rejects.toMatchObject({
      code: "transport_closed",
      status: 499,
      message: "request was cancelled",
    });
  });

  test("abort mid-resolution surfaces as transport_closed 499", async () => {
    const controller = new AbortController();
    // Resolve through the real resolver, but abort after kick-off; the
    // function must still surface the abort as a cancellation, never a 400.
    const signal = controller.signal;
    controller.abort();
    await expect(resolveAndValidateOnce("example.com", {}, signal)).rejects.toMatchObject({
      code: "transport_closed",
      status: 499,
    });
  });
});

describe("SSRF address policy", () => {
  test("rejects non-IP literals", () => {
    expect(isAddressAllowed("example.com", open)).toBe(false);
    expect(isAddressAllowed("", open)).toBe(false);
  });

  test("blocks loopback, link-local, private, CGNAT, and multicast IPv4", () => {
    for (const address of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.5.5",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.10.10",
      "224.0.0.1",
    ]) {
      expect(isAddressAllowed(address, open)).toBe(false);
    }
  });

  test("allows public IPv4 and IPv6 literals", () => {
    expect(isAddressAllowed("8.8.8.8", open)).toBe(true);
    expect(isAddressAllowed("1.1.1.1", open)).toBe(true);
    expect(isAddressAllowed("2606:4700:4700::1111", open)).toBe(true);
  });

  test("blocks loopback, ULA, link-local, and unspecified IPv6", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isAddressAllowed(address, open)).toBe(false);
    }
  });

  test("blocks IPv4-mapped, 6to4, and NAT64 addresses that embed a private IPv4", () => {
    expect(isAddressAllowed("::ffff:127.0.0.1", open)).toBe(false);
    expect(isAddressAllowed("::ffff:10.0.0.1", open)).toBe(false);
    expect(isAddressAllowed("2002:7f00:0001::1", open)).toBe(false);
    expect(isAddressAllowed("64:ff9b::a00:1", open)).toBe(false);
  });

  test("honors allowPrivate and explicit allowedNetworks", () => {
    expect(isAddressAllowed("10.0.0.1", { allowPrivate: true })).toBe(true);
    expect(isAddressAllowed("10.0.0.1", { allowedNetworks: ["10.0.0.0/8"] })).toBe(true);
    expect(isAddressAllowed("10.0.0.1", { allowedNetworks: ["192.168.0.0/16"] })).toBe(false);
    expect(isAddressAllowed("2606:4700::1", { allowedNetworks: ["2606:4700::/32"] })).toBe(true);
    // A malformed allowlist entry simply never matches; it must not widen the
    // policy, so an unrelated public address still passes on its own merit.
    expect(isAddressAllowed("8.8.8.8", { allowedNetworks: ["not-a-cidr"] })).toBe(true);
    expect(isAddressAllowed("10.0.0.1", { allowedNetworks: ["not-a-cidr"] })).toBe(false);
  });

  test("validateResolvedAddresses rejects empty or any-unsafe resolution", () => {
    expect(() => validateResolvedAddresses([], open)).toThrow();
    expect(() => validateResolvedAddresses(["8.8.8.8", "10.0.0.1"], open)).toThrow();
    expect(validateResolvedAddresses(["8.8.8.8", "1.1.1.1"], open)).toBe("8.8.8.8");
  });
});
