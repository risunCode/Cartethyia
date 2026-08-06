import { describe, expect, test } from "bun:test";
import { assertPublicUrl, assertPublicUrlAtDispatch, fetchWithSsrfGuard, isBlockedIp, SsrfGuardError, validatePublicUrl } from "../../src/security/ssrf-guard";
import { RedirectPolicyError, fetchWithRedirectPolicy } from "../../src/security/redirect-policy";
import type { ResolvedAddress } from "../../src/security/ssrf-guard";

const HTTPS_ONLY: Readonly<Record<string, true>> = { "https:": true };

async function resolver(records: readonly string[]): Promise<readonly ResolvedAddress[]> {
  return records.map((address) => ({ address }));
}

describe("ssrf guard address classification", () => {
  test("blocks private, loopback, link-local, and reserved IPs", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("192.0.2.1")).toBe(true);
    expect(isBlockedIp("224.0.0.1")).toBe(true);
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });

  test("allows public IPs", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("172.32.0.1")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("ssrf guard URL validation", () => {
  test("rejects private and internal hosts at URL level", () => {
    for (const raw of [
      "http://127.0.0.1/",
      "http://localhost/",
      "http://10.10.10.10/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://metadata.google.internal/",
      "http://instance-data/",
      "http://router.internal/",
      "http://0.0.0.0/",
    ]) {
      expect(() => assertPublicUrl(raw)).toThrow();
    }
  });

  test("accepts public URLs and proxy-pool schemes", () => {
    expect(assertPublicUrl("https://api.openai.com/v1").hostname).toBe("api.openai.com");
    expect(() => assertPublicUrl("http://example.com/")).not.toThrow();
    expect(() => assertPublicUrl("socks5://proxy.example.com:1080")).not.toThrow();
  });

  test("rejects unsupported protocols and malformed URLs", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(/protocol/);
    expect(() => assertPublicUrl("ftp://example.com/")).toThrow(/protocol/);
    expect(() => assertPublicUrl("not a url")).toThrow(/malformed/);
    expect(() => assertPublicUrl("")).toThrow(/no URL/);
  });

  test("enforces an https-only policy via allowedProtocols", () => {
    expect(() => assertPublicUrl("http://example.com/", { allowedProtocols: HTTPS_ONLY })).toThrow(/protocol/);
    expect(assertPublicUrl("https://example.com/", { allowedProtocols: HTTPS_ONLY }).protocol).toBe("https:");
  });

  test("re-checks DNS-resolved addresses at dispatch", async () => {
    await expect(assertPublicUrlAtDispatch("https://example.com/x", { lookup: () => resolver(["127.0.0.1"]) })).rejects.toThrow("Blocked private IP address");
    await expect(assertPublicUrlAtDispatch("https://example.com/x", { lookup: () => resolver(["10.0.0.9"]) })).rejects.toThrow("Blocked private IP address");
    const safe = await assertPublicUrlAtDispatch("https://example.com/x", { lookup: () => resolver(["8.8.8.8", "1.1.1.1"]) });
    expect(safe.hostname).toBe("example.com");
  });

  test("validatePublicUrl returns clean errors instead of throwing", () => {
    expect(validatePublicUrl("https://example.com/")).toBeNull();
    expect(validatePublicUrl("http://10.0.0.1/")).toContain("Blocked private IP address:");
  });
});

describe("redirect policy", () => {
  test("re-validates every hop and returns the final response", async () => {
    const hops: string[] = [];
    const fetcher = async (url: string): Promise<Response> => {
      hops.push(url);
      return url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/next" } })
        : new Response("ok", { status: 200 });
    };
    const validator = async (url: string): Promise<void> => {
      hops.push(`v:${url}`);
    };
    const response = await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, validator });
    expect(response.status).toBe(200);
    expect(hops).toEqual([
      "v:https://example.com/start",
      "https://example.com/start",
      "v:https://example.com/next",
      "https://example.com/next",
    ]);
  });

  test("bounded redirect chains fail with a typed error", async () => {
    const fetcher = async (): Promise<Response> => new Response(null, { status: 302, headers: { location: "https://example.com/loop" } });
    let caught: unknown;
    try {
      await fetchWithRedirectPolicy("https://example.com/loop", {}, { fetcher, maxRedirects: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("too_many_redirects");
  });

  test("refuses non-http redirect targets", async () => {
    const fetcher = async (): Promise<Response> => new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } });
    let caught: unknown;
    try {
      await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("bad_redirect_target");
  });

  test("a rejecting validator aborts the hop", async () => {
    const fetcher = async (): Promise<Response> => new Response("ok", { status: 200 });
    await expect(
      fetchWithRedirectPolicy("https://example.com/x", {}, { fetcher, validator: () => { throw new Error("blocked by policy"); } }),
    ).rejects.toThrow("blocked by policy");
  });

  test("fetchWithSsrfGuard follows public redirects re-validating each hop", async () => {
    const hops: string[] = [];
    const fetcher = async (url: string, _init: RequestInit): Promise<Response> => {
      hops.push("fetch:" + url);
      return url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "http://8.8.8.8/next" } })
        : new Response("ok", { status: 200 });
    };
    const response = await fetchWithSsrfGuard("http://8.8.8.8/start", {}, { fetcher });
    expect(response.status).toBe(200);
    expect(hops).toContain("fetch:http://8.8.8.8/next");
  });

  test("fetchWithSsrfGuard blocks a redirect hop jumping to a private IP", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/metadata" } });
    let caught: unknown;
    try {
      await fetchWithSsrfGuard("http://8.8.8.8/start", {}, { fetcher });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("blocked_ip");
  });

  });
