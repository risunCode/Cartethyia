/** Dispatch-time SSRF protections reject DNS rebinding and unsafe redirects. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { assertPublicUrlAtDispatch, fetchWithSsrfGuard } from "../../src/http/ssrf-guard";

type DnsLookupSpy = ReturnType<typeof spyOn<typeof Bun.dns, "lookup">>;
type FetchSpy = ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

let dnsLookupSpy: DnsLookupSpy;
let fetchSpy: FetchSpy;

beforeEach(() => {
  dnsLookupSpy = spyOn(Bun.dns, "lookup");
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  dnsLookupSpy.mockRestore();
  fetchSpy.mockRestore();
});

describe("assertPublicUrlAtDispatch", () => {
  test("rejects a hostname that resolves to a private address", async () => {
    dnsLookupSpy.mockResolvedValue([{ address: "127.0.0.1", family: 4, ttl: 0 }]);

    await expect(assertPublicUrlAtDispatch("https://provider.example/v1")).rejects.toThrow("Blocked private IP");
  });
});

describe("fetchWithSsrfGuard", () => {
  test("does not follow a redirect to cloud metadata", async () => {
    dnsLookupSpy.mockResolvedValue([{ address: "93.184.216.34", family: 4, ttl: 0 }]);
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      })
    );

    await expect(fetchWithSsrfGuard("https://provider.example/v1", { method: "GET" })).rejects.toThrow("blocked");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
