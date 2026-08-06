import { describe, expect, test } from "bun:test";
import { fetchProviderQuota } from "../../src/console/quota-fetcher";

function fakeFetch(body: Record<string, unknown>, status = 200): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))) as never;
}

const throwingFetch: typeof fetch = (() => {
  throw new Error("network should not be called");
}) as never;

const failingFetch: typeof fetch = (() => Promise.reject(new Error("Bearer sk-leaked-token connection refused"))) as never;

describe("fetchProviderQuota — unknown provider", () => {
  test("returns a not-available error without touching the network", async () => {
    const result = await fetchProviderQuota("unknown-provider", "tok", undefined, throwingFetch);
    expect(result.source).toBe("unknown-provider");
    expect(result.windows).toEqual([]);
    expect(result.error).toBe("Quota endpoint is not available for this provider.");
  });
});

describe("fetchProviderQuota — error wrapping", () => {
  test("wraps a network failure into a sanitized error and never leaks a bearer token", async () => {
    const result = await fetchProviderQuota("codex", "tok", undefined, failingFetch);
    expect(result.source).toBe("codex");
    expect(result.windows).toEqual([]);
    expect(result.error).not.toContain("sk-leaked-token");
    expect(result.error).toContain("[redacted]");
  });
});

describe("fetchProviderQuota — codex success path", () => {
  test("parses a codex usage body into windows", async () => {
    const result = await fetchProviderQuota("codex", "tok", undefined, fakeFetch({
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 3600, reset_at: "2026-08-06T00:00:00.000Z" },
        secondary_window: { used_percent: 10, limit_window_seconds: 86_400, reset_after_seconds: 7200 },
      },
    }));
    expect(result.source).toBe("codex");
    expect(result.error).toBe(null);
    expect(result.windows.length).toBe(2);
  });
});

describe("fetchProviderQuota — cline credential guard", () => {
  test("throws a clean error when a cline credential has no access token", async () => {
    const result = await fetchProviderQuota("cline", JSON.stringify({ foo: "bar" }), undefined, fakeFetch({}));
    expect(result.source).toBe("cline");
    expect(result.error).toContain("access token");
  });
});
