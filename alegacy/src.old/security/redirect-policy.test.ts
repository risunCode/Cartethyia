import { describe, expect, test } from "bun:test";
import {
  MAX_REDIRECTS,
  RedirectPolicyError,
  fetchWithRedirectPolicy,
  resolveRedirectTarget,
} from "./redirect-policy";

describe("redirect policy", () => {
  test("resolves relative redirects and rejects non-http schemes", () => {
    expect(resolveRedirectTarget("https://example.com/a", "/b")).toBe("https://example.com/b");
    expect(resolveRedirectTarget("https://example.com/a", "https://cdn.example.com/b")).toBe("https://cdn.example.com/b");
    expect(() => resolveRedirectTarget("https://example.com/a", "javascript:alert(1)")).toThrowError(
      expect.objectContaining({ kind: "bad_redirect_target" }),
    );
  });

  test("validates every hop and forces manual redirect handling", async () => {
    const requested: string[] = [];
    const validated: string[] = [];
    const responses = [
      new Response(null, { status: 302, headers: { location: "/next" } }),
      new Response(null, { status: 302, headers: { location: "https://cdn.example.com/final" } }),
      new Response("ok", { status: 200 }),
    ];

    const response = await fetchWithRedirectPolicy("https://example.com/start", { method: "GET" }, {
      validator: (url) => { validated.push(url); },
      fetcher: async (url, init) => {
        requested.push(`${url}|${init.redirect}`);
        return responses.shift() ?? new Response("missing", { status: 500 });
      },
    });

    expect(response.status).toBe(200);
    expect(requested).toEqual([
      "https://example.com/start|manual",
      "https://example.com/next|manual",
      "https://cdn.example.com/final|manual",
    ]);
    expect(validated).toEqual([
      "https://example.com/start",
      "https://example.com/next",
      "https://cdn.example.com/final",
    ]);
  });

  test("stops an unbounded redirect chain at the shared maximum", async () => {
    await expect(fetchWithRedirectPolicy("https://example.com/start", {}, {
      maxRedirects: MAX_REDIRECTS + 10,
      fetcher: async () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    })).rejects.toMatchObject({ kind: "too_many_redirects" });

    expect(RedirectPolicyError).toBeDefined();
  });
});
