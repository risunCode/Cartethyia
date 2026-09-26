import { describe, expect, test } from "bun:test";
import { createValidatedFetch } from "../../src/network/outbound-fetch";
import { createHttpProxyAgent } from "../../src/network/pool/agent";
import { GatewayError } from "../../src/transport/gateway-error";
import { metrics } from "../../src/observability/metrics";

interface Hop {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Injected transport for the validated fetcher: records every hop and returns
 * the next scripted response. A fresh `Response` per hop keeps bodies
 * single-use, matching a real transport.
 */
function scriptedFetch(script: ReadonlyArray<() => Response>): {
  readonly calls: Hop[];
  readonly fetchFn: typeof fetch;
} {
  const calls: Hop[] = [];
  let index = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init: init ?? {} });
    const step = script[index];
    index += 1;
    if (!step) throw new Error(`unexpected fetch call ${index}`);
    return step();
  }) as typeof fetch;
  return { calls, fetchFn };
}

function redirect(status: number, location?: string): () => Response {
  return () => {
    const headers = new Headers();
    if (location !== undefined) headers.set("location", location);
    return new Response(null, { status, headers });
  };
}

function ok(body: string, status = 200): () => Response {
  return () => new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** A public unicast address, so the default SSRF policy accepts it. */
const resolvePublic = async (): Promise<readonly string[]> => ["93.184.216.34"];

function counterValue(name: string): number {
  const match = metrics.render().match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "m"));
  return match ? Number(match[1]) : 0;
}

describe("createValidatedFetch redirect policy", () => {
  test("a single non-redirect response is returned without a second hop", async () => {
    const { calls, fetchFn } = scriptedFetch([ok("done")]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    const response = await fetchFnValidated("https://origin.example.com/path?q=1");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://origin.example.com/path?q=1");
    // Redirect handling is manual: the injected transport never auto-follows.
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("a 3xx without a location header is returned to the caller", async () => {
    const { calls, fetchFn } = scriptedFetch([redirect(302)]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    const response = await fetchFnValidated("https://origin.example.com/start");
    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  test("a 301/302/303 rewrite a body-bearing method to GET and drop the body", async () => {
    const { calls, fetchFn } = scriptedFetch([
      redirect(303, "/next"),
      ok("followed"),
    ]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    const response = await fetchFnValidated("https://origin.example.com/start", {
      method: "POST",
      body: "payload",
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://origin.example.com/next");
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.init.body).toBeUndefined();
  });

  test("a 307 on the same origin keeps the method and body", async () => {
    const { calls, fetchFn } = scriptedFetch([redirect(307, "/next"), ok("followed")]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    await fetchFnValidated("https://origin.example.com/start", { method: "PUT", body: "payload" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.init.body).toBe("payload");
  });

  test("a cross-origin redirect strips authorization, cookie, and proxy-authorization", async () => {
    const { calls, fetchFn } = scriptedFetch([redirect(302, "https://elsewhere.example.net/next"), ok("ok")]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    await fetchFnValidated("https://origin.example.com/start", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=1",
        "proxy-authorization": "Basic abc",
        "x-keep": "yes",
      },
    });
    expect(calls).toHaveLength(2);
    const followed = new Headers(calls[1]?.init.headers);
    expect(followed.get("authorization")).toBeNull();
    expect(followed.get("cookie")).toBeNull();
    expect(followed.get("proxy-authorization")).toBeNull();
    expect(followed.get("x-keep")).toBe("yes");
  });

  test("a same-origin redirect keeps the credential headers", async () => {
    const { calls, fetchFn } = scriptedFetch([redirect(302, "/next"), ok("ok")]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    await fetchFnValidated("https://origin.example.com/start", {
      headers: { authorization: "Bearer secret" },
    });
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer secret");
  });

  test("a cross-origin 307 carrying a body is refused, not silently resent", async () => {
    const { calls, fetchFn } = scriptedFetch([redirect(307, "https://elsewhere.example.net/next")]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    const attempt = fetchFnValidated("https://origin.example.com/start", {
      method: "POST",
      body: "payload",
    });
    await expect(attempt).rejects.toThrow("cross-origin redirect with body blocked");
    await expect(attempt).rejects.toBeInstanceOf(GatewayError);
    // The body was never forwarded to the foreign origin.
    expect(calls).toHaveLength(1);
  });

  test("a cross-origin 307 with a GET is followed without a body", async () => {
    const { calls, fetchFn } = scriptedFetch([
      redirect(307, "https://elsewhere.example.net/next"),
      ok("ok"),
    ]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    const response = await fetchFnValidated("https://origin.example.com/start");
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("the redirect response body is cancelled before the next hop", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("redirect"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetchFn } = scriptedFetch([
      () => new Response(stream, { status: 302, headers: { location: "/next" } }),
      ok("ok"),
    ]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    await fetchFnValidated("https://origin.example.com/start");
    expect(cancelled).toBe(true);
  });

  test("exceeding maxRedirects fails instead of looping forever", async () => {
    const { calls, fetchFn } = scriptedFetch([
      redirect(302, "/loop"),
      redirect(302, "/loop"),
      redirect(302, "/loop"),
    ]);
    const fetchFnValidated = createValidatedFetch({
      fetchFn,
      resolveFn: resolvePublic,
      maxRedirects: 2,
    });
    await expect(fetchFnValidated("https://origin.example.com/loop")).rejects.toThrow(
      "outbound redirect limit exceeded",
    );
    expect(calls).toHaveLength(3);
  });
});

describe("createValidatedFetch target validation", () => {
  test("a non-http(s) protocol is rejected before any transport call", async () => {
    const { calls, fetchFn } = scriptedFetch([]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    await expect(fetchFnValidated("ftp://origin.example.com/file")).rejects.toThrow(
      "unsupported outbound URL protocol",
    );
    expect(calls).toHaveLength(0);
  });

  test("a resolver failure on a direct dial becomes a no-validated-address error", async () => {
    const { calls, fetchFn } = scriptedFetch([]);
    const fetchFnValidated = createValidatedFetch({
      fetchFn,
      resolveFn: async () => {
        throw new Error("upstream DNS resolution failed");
      },
    });
    await expect(fetchFnValidated("https://origin.example.com/")).rejects.toThrow(
      "no validated address for origin.example.com",
    );
    expect(calls).toHaveLength(0);
  });

  test("an empty resolution is rejected as unsafe, not dialed", async () => {
    const { calls, fetchFn } = scriptedFetch([]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: async () => [] });
    await expect(fetchFnValidated("https://origin.example.com/")).rejects.toThrow(
      "no validated address for origin.example.com",
    );
    expect(calls).toHaveLength(0);
  });

  test("a private address is rejected by the default policy", async () => {
    const { calls, fetchFn } = scriptedFetch([]);
    const fetchFnValidated = createValidatedFetch({
      fetchFn,
      resolveFn: async () => ["10.0.0.5"],
    });
    await expect(fetchFnValidated("https://origin.example.com/")).rejects.toThrow(
      "no validated address for origin.example.com",
    );
    expect(calls).toHaveLength(0);
  });

  test("a Request input contributes its headers to the first hop", async () => {
    const { calls, fetchFn } = scriptedFetch([ok("ok")]);
    const fetchFnValidated = createValidatedFetch({ fetchFn, resolveFn: resolvePublic });
    const response = await fetchFnValidated(
      new Request("https://origin.example.com/", { headers: { "x-from-request": "1" } }),
    );
    expect(response.status).toBe(200);
    expect(new Headers(calls[0]?.init.headers).get("x-from-request")).toBe("1");
  });
});

describe("createValidatedFetch relay dials", () => {
  const relayAgent = () =>
    createHttpProxyAgent("https://relay-user:relay-pass@my-app.vercel.app");

  test("a relay dial rewrites the target into relay headers and counts the fallback", async () => {
    const { calls, fetchFn } = scriptedFetch([ok("relayed")]);
    const before = counterValue("cartethyia_proxy_dial_dns_fallback_total");
    const fetchFnValidated = createValidatedFetch({
      fetchFn,
      resolveFn: resolvePublic,
      agent: relayAgent(),
    });
    const response = await fetchFnValidated("https://api.example.com/v1/chat?stream=1", {
      headers: { host: "api.example.com", authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://my-app.vercel.app/");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-relay-target")).toBe("https://api.example.com");
    expect(headers.get("x-relay-path")).toBe("/v1/chat?stream=1");
    // The relay's own credentials become a Basic auth header; the target's
    // credentials stay on the request for the relay to forward.
    expect(headers.get("x-relay-auth")).toBe(
      `Basic ${Buffer.from("relay-user:relay-pass").toString("base64")}`,
    );
    expect(headers.get("host")).toBeNull();
    expect(counterValue("cartethyia_proxy_dial_dns_fallback_total")).toBe(before + 1);
  });

  test("a relay whose egress host cannot resolve fails loudly", async () => {
    const { calls, fetchFn } = scriptedFetch([]);
    const fetchFnValidated = createValidatedFetch({
      fetchFn,
      agent: relayAgent(),
      resolveFn: async (hostname: string) => {
        if (hostname === "my-app.vercel.app") throw new Error("relay DNS down");
        return ["93.184.216.34"];
      },
    });
    await expect(fetchFnValidated("https://api.example.com/v1")).rejects.toThrow("relay DNS down");
    expect(calls).toHaveLength(0);
  });

  test("a relay host that resolves to nothing fails loudly", async () => {
    const { calls, fetchFn } = scriptedFetch([]);
    const fetchFnValidated = createValidatedFetch({
      fetchFn,
      agent: relayAgent(),
      resolveFn: async (hostname: string) =>
        hostname === "my-app.vercel.app" ? [] : ["93.184.216.34"],
    });
    await expect(fetchFnValidated("https://api.example.com/v1")).rejects.toThrow(
      "unsafe upstream address rejected",
    );
    expect(calls).toHaveLength(0);
  });
});
