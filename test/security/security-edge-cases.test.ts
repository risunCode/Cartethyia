import { describe, expect, test } from "bun:test";
import { assertPublicUrl, assertPublicUrlAtDispatch, fetchWithSsrfGuard, MAX_SSRF_URL_LENGTH, SsrfGuardError } from "../../src/security/ssrf-guard";
import { RedirectPolicyError, fetchWithRedirectPolicy, resolveRedirectTarget } from "../../src/security/redirect-policy";
import type { ResolvedAddress } from "../../src/security/ssrf-guard";

/** Resolver that resolves to the given addresses — avoids real DNS in tests. */
function resolver(records: readonly string[]): (host: string) => Promise<readonly ResolvedAddress[]> {
  return () => Promise.resolve(records.map((address) => ({ address })));
}

/** Builds a URL string of exactly `len` characters by padding the path. */
function urlOfLength(len: number): string {
  const prefix = "https://example.com/";
  if (prefix.length > len) throw new Error("length too short");
  return prefix + "x".repeat(len - prefix.length);
}

describe("assertPublicUrl MAX_SSRF_URL_LENGTH enforcement", () => {
  test("accepts a URL exactly at the length limit", () => {
    const at = urlOfLength(MAX_SSRF_URL_LENGTH);
    expect(at.length).toBe(MAX_SSRF_URL_LENGTH);
    expect(() => assertPublicUrl(at)).not.toThrow();
  });

  test("rejects a URL one character over the length limit", () => {
    const over = urlOfLength(MAX_SSRF_URL_LENGTH + 1);
    expect(over.length).toBe(MAX_SSRF_URL_LENGTH + 1);
    let caught: unknown;
    try {
      assertPublicUrl(over);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("invalid_url");
    expect((caught as SsrfGuardError).message).toContain("exceeds");
  });

  test("length check happens before URL parse so malformed over-length fails on length", () => {
    const malformed = "x".repeat(MAX_SSRF_URL_LENGTH + 1);
    let caught: unknown;
    try {
      assertPublicUrl(malformed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("invalid_url");
    expect((caught as SsrfGuardError).message).toContain("exceeds");
  });
});

describe("assertPublicUrl IP-literal dispatch", () => {
  test("blocks a private IP passed directly as URL host", () => {
    let caught: unknown;
    try {
      assertPublicUrl("http://10.0.0.5/");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("blocked_ip");
    expect((caught as SsrfGuardError).message).toContain("Blocked private IP address");
  });

  test("blocks a loopback IP passed directly as URL host", () => {
    let caught: unknown;
    try {
      assertPublicUrl("http://127.0.0.1:8080/");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("blocked_ip");
  });

  test("blocks a link-local IP passed directly as URL host", () => {
    let caught: unknown;
    try {
      assertPublicUrl("http://169.254.169.254/");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("blocked_ip");
  });

  test("blocks an IPv6 loopback passed directly as URL host", () => {
    let caught: unknown;
    try {
      assertPublicUrl("http://[::1]/");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("blocked_ip");
  });

  test("allows a public IP literal passed directly as URL host", () => {
    const url = assertPublicUrl("http://8.8.8.8/");
    expect(url.hostname).toBe("8.8.8.8");
  });
});

describe("assertPublicUrlAtDispatch default DNS lookup path", () => {
  test("resolves a public hostname that stays public after DNS", async () => {
    const url = await assertPublicUrlAtDispatch("https://example.com/x", {
      lookup: resolver(["8.8.8.8", "1.1.1.1"]),
    });
    expect(url.hostname).toBe("example.com");
  });

  test("rejects when DNS rebinding resolves to a private IP after initial validation", async () => {
    let caught: unknown;
    try {
      await assertPublicUrlAtDispatch("https://example.com/x", {
        lookup: resolver(["127.0.0.1"]),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("blocked_ip");
    expect((caught as SsrfGuardError).message).toContain("Blocked private IP address");
  });

  test("rejects when any one resolved record is a private IP (mixed addresses)", async () => {
    let caught: unknown;
    try {
      await assertPublicUrlAtDispatch("https://example.com/x", {
        lookup: resolver(["8.8.8.8", "10.0.0.5"]),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SsrfGuardError);
    expect((caught as SsrfGuardError).reason).toBe("blocked_ip");
  });

  test("returns immediately for an IP literal host without calling lookup", async () => {
    const url = await assertPublicUrlAtDispatch("http://8.8.8.8/x", {
      lookup: resolver(["127.0.0.1"]),
    });
    expect(url.hostname).toBe("8.8.8.8");
  });
});

describe("fetchWithSsrfGuard maxRedirects boundary", () => {
  test("maxRedirects=0 returns the response when the target is non-redirect", async () => {
    const fetcher = async (): Promise<Response> => new Response("ok", { status: 200 });
    const response = await fetchWithSsrfGuard("http://8.8.8.8/start", {}, { fetcher, maxRedirects: 0 });
    expect(response.status).toBe(200);
  });

  test("maxRedirects=0 with a redirect response throws too_many_redirects (no following)", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(null, { status: 302, headers: { location: "http://8.8.8.8/next" } });
    let caught: unknown;
    try {
      await fetchWithSsrfGuard("http://8.8.8.8/start", {}, { fetcher, maxRedirects: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("too_many_redirects");
  });

  test("maxRedirects=NaN falls back to the policy default and follows up to MAX_REDIRECTS", async () => {
    const fetcher = async (url: string): Promise<Response> =>
      url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "http://8.8.8.8/next" } })
        : new Response("ok", { status: 200 });
    const response = await fetchWithSsrfGuard("http://8.8.8.8/start", {}, { fetcher, maxRedirects: NaN });
    expect(response.status).toBe(200);
  });

  test("maxRedirects=Infinity is clamped to MAX_REDIRECTS and does not loop forever", async () => {
    let hops = 0;
    const fetcher = async (): Promise<Response> => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: "http://8.8.8.8/loop" } });
    };
    let caught: unknown;
    try {
      await fetchWithSsrfGuard("http://8.8.8.8/start", {}, { fetcher, maxRedirects: Infinity });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("too_many_redirects");
    expect(hops).toBeLessThanOrEqual(6);
  });
});

describe("async validator rejection aborts the redirect chain", () => {
  test("a rejecting validator on fetchWithRedirectPolicy aborts before fetch", async () => {
    const fetcher = async (): Promise<Response> => new Response("ok", { status: 200 });
    let caught: unknown;
    try {
      await fetchWithRedirectPolicy("https://example.com/x", {}, {
        fetcher,
        validator: async () => {
          throw new Error("validator rejected hop");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("validator rejected hop");
  });

  test("a rejecting async validator is awaited (not swallowed as unhandled rejection)", async () => {
    const fetcher = async (): Promise<Response> => new Response("ok", { status: 200 });
    let caught: unknown;
    try {
      await fetchWithRedirectPolicy("https://example.com/x", {}, {
        fetcher,
        validator: () => Promise.reject(new Error("async validator rejected")),
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("async validator rejected");
  });
});

describe("resolveRedirectTarget edge cases", () => {
  test("resolves a relative path-only Location against the base URL", () => {
    const target = resolveRedirectTarget("https://example.com/start", "/next");
    expect(target).toBe("https://example.com/next");
  });

  test("resolves a relative path with nested segments against the base path", () => {
    const target = resolveRedirectTarget("https://example.com/api/v1", "start");
    expect(target).toBe("https://example.com/api/start");
  });

  test("resolves a protocol-relative Location (//host/path)", () => {
    const target = resolveRedirectTarget("https://example.com/start", "//cdn.example.com/asset");
    expect(target).toBe("https://cdn.example.com/asset");
  });

  test("inherits protocol from base for protocol-relative http target", () => {
    const target = resolveRedirectTarget("http://example.com/start", "//cdn.example.com/asset");
    expect(target).toBe("http://cdn.example.com/asset");
  });

  test("rejects an invalid Location with a typed bad_redirect_target error", () => {
    let caught: unknown;
    try {
      resolveRedirectTarget("https://example.com/start", "http://[invalid");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("bad_redirect_target");
    expect((caught as RedirectPolicyError).message).toContain("not a valid URL");
  });

  test("rejects a javascript: Location with a typed bad_redirect_target error", () => {
    let caught: unknown;
    try {
      resolveRedirectTarget("https://example.com/start", "javascript:alert(1)");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("bad_redirect_target");
    expect((caught as RedirectPolicyError).message).toContain("unsupported protocol");
  });

  test("same-origin redirect resolves to an absolute URL on the same host", () => {
    const target = resolveRedirectTarget("https://example.com/start", "https://example.com/next");
    expect(target).toBe("https://example.com/next");
  });
});

describe("fetchWithRedirectPolicy boundary behavior", () => {
  test("maxRedirects=0 returns a non-redirect response without following", async () => {
    const fetcher = async (): Promise<Response> => new Response("ok", { status: 200 });
    const response = await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: 0 });
    expect(response.status).toBe(200);
  });

  test("maxRedirects=0 with a redirect response throws too_many_redirects", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(null, { status: 302, headers: { location: "https://example.com/next" } });
    let caught: unknown;
    try {
      await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("too_many_redirects");
  });

  test("maxRedirects=NaN falls back to MAX_REDIRECTS and follows a short chain", async () => {
    const fetcher = async (url: string): Promise<Response> =>
      url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "https://example.com/next" } })
        : new Response("ok", { status: 200 });
    const response = await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: NaN });
    expect(response.status).toBe(200);
  });

  test("maxRedirects=Infinity is clamped to MAX_REDIRECTS and eventually fails on an infinite loop", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(null, { status: 302, headers: { location: "https://example.com/loop" } });
    let caught: unknown;
    try {
      await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: Infinity });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectPolicyError);
    expect((caught as RedirectPolicyError).kind).toBe("too_many_redirects");
  });

  test("3xx without a Location header returns the response immediately", async () => {
    const fetcher = async (): Promise<Response> => new Response(null, { status: 302 });
    const response = await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: 5 });
    expect(response.status).toBe(302);
  });

  test.each([
    [300, "multiple choices"],
    [301, "moved permanently"],
    [302, "found"],
    [303, "see other"],
    [307, "temporary redirect"],
    [308, "permanent redirect"],
    [399, "upper boundary of redirect range"],
  ] as const)("follows status %i as a redirect when a Location is present", async (status, _label) => {
    const fetcher = async (url: string): Promise<Response> =>
      url.endsWith("/start")
        ? new Response(null, { status, headers: { location: "https://example.com/next" } })
        : new Response("ok", { status: 200 });
    const response = await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: 5 });
    expect(response.status).toBe(200);
  });

  test("status 400 (non-redirect) returns the response immediately without following", async () => {
    const fetcher = async (): Promise<Response> => new Response("bad", { status: 400, headers: { location: "https://example.com/next" } });
    const response = await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: 5 });
    expect(response.status).toBe(400);
  });

  test("status 200 returns the response immediately", async () => {
    const fetcher = async (): Promise<Response> => new Response("ok", { status: 200 });
    const response = await fetchWithRedirectPolicy("https://example.com/start", {}, { fetcher, maxRedirects: 5 });
    expect(response.status).toBe(200);
  });
});
