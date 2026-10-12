import { describe, expect, test } from "bun:test";
import { promises as dns } from "node:dns";
import { resolveAllAddresses } from "../../src/network/ssrf";
import { GatewayError } from "../../src/protocol/gateway-error";

describe("direct DNS behind a broken c-ares resolver", () => {
  test("an aborted lookup rejects promptly and preserves a typed deadline", async () => {
    const controller = new AbortController();
    const deadline = new GatewayError("deadline_exceeded", 504, "request deadline exceeded");
    const pendingLookup = resolveAllAddresses(
      `pending-${Date.now()}.example`,
      controller.signal,
      () => new Promise<readonly { address: string; family: number }[]>(() => undefined),
    );

    controller.abort(deadline);
    await expect(pendingLookup).rejects.toBe(deadline);
  });

  test("uses the OS resolver when the configured c-ares server refuses queries", async () => {
    const original = dns.getServers();
    dns.setServers(["127.0.0.1:9"]);
    try {
      const direct = await dns.resolve4("example.com").then(() => "answered").catch((error: { code?: string }) => error.code);
      expect(direct).toBe("ECONNREFUSED");
      const addresses = await resolveAllAddresses("example.com", new AbortController().signal);
      expect(addresses.length).toBeGreaterThan(0);
      expect(addresses.every((address) => address.includes("."))).toBe(true);
    } finally {
      dns.setServers(original);
    }
  });

  test("keeps the resolver failure diagnosable", async () => {
    try {
      await resolveAllAddresses(
        "missing.invalid",
        new AbortController().signal,
        async () => {
          throw new Error("DNS lookup failed: getaddrinfo ENOTFOUND missing.invalid");
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("transport_unavailable");
      expect((error as GatewayError).status).toBe(502);
      // The diagnosable part is that the resolver's own reason survives into
      // `details.cause`; which reason is an environment fact, not a contract.
      //
      // This used to pin `"DNS lookup timed out"`, which assumed a resolver that
      // swallows the query. A router that answers NXDOMAIN for `.invalid` — the
      // correct answer for a reserved TLD — fails immediately with
      // `getaddrinfo ENOTFOUND` instead, so the pin failed on a machine whose DNS
      // was working properly. Measured on this host: `192.168.1.1 can't find
      // missing-….invalid: Non-existent domain`.
      //
      // Asserting the shape rather than the one spelling still fails if the cause
      // were dropped entirely, which is the defect this test exists to catch.
      const cause = String((error as GatewayError).details.cause);
      expect(cause.toLowerCase()).toContain("dns");
      return;
    }
    throw new Error("missing hostname resolved");
  });
});
