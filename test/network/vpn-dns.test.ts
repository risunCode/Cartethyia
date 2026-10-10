import { describe, expect, test } from "bun:test";
import { promises as dns } from "node:dns";
import { resolveAllAddresses } from "../../src/network/ssrf";
import { GatewayError } from "../../src/protocol/gateway-error";

describe("direct DNS behind a broken c-ares resolver", () => {
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
      await resolveAllAddresses(`missing-${Date.now()}.invalid`, new AbortController().signal);
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("transport_unavailable");
      expect((error as GatewayError).status).toBe(502);
      expect(String((error as GatewayError).details.cause)).toContain("DNS lookup timed out");
      return;
    }
    throw new Error("missing hostname resolved");
  });
});
