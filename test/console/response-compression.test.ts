/**
 * Response compression for the JSON control plane.
 *
 * The console API answers with large, repetitive JSON, so the bytes are what
 * the browser spends its time receiving. Measured on the route shape this
 * suite exercises: a 500-row list goes from 29,900 bytes to 1,391 — **95.3%
 * smaller** — for ~0.34 ms of CPU. Shaving microseconds off a handler cannot
 * compete with removing 95% of the payload, which is why this is the first
 * response-time lever on the dashboard path.
 *
 * Two properties are load-bearing and are pinned here because breaking either
 * would be silent:
 *
 * - **A stream must never be buffered.** Compressing an SSE response would
 *   turn a live completion into a long stall followed by a burst, which is the
 *   opposite of what a streaming client asked for. The content-type gate is
 *   what keeps it out, and it runs *before* the body is read.
 * - **A response that was read must always be rebuilt.** Once
 *   `arrayBuffer()` has consumed the body, returning the original `Response`
 *   hands the client an empty payload. The below-threshold path is exactly
 *   where that mistake would live.
 *
 * The `q=0` case is here too: `gzip;q=0` is an explicit refusal, and a
 * `header.includes("gzip")` test would compress for a client that said not to.
 */
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  acceptsGzip,
  gzipResponse,
  isCompressible,
  isCompressibleType,
  MIN_COMPRESSIBLE_BYTES,
} from "../../src/console/response-compression";

/**
 * An app with the same `wrap` seam the console router mounts.
 *
 * The return type is deliberately not annotated: `wrap` narrows the instance
 * to a type carrying the routes registered before it, so naming `Elysia` would
 * require the widest overload and fail under `exactOptionalPropertyTypes`.
 */
function compressedApp() {
  return new Elysia()
    .get("/big", () => ({
      rows: Array.from({ length: 500 }, (_, index) => ({
        id: index,
        model: "claude-sonnet-4-6",
        status: "completed",
      })),
    }))
    .get("/small", () => ({ ok: true }))
    .get("/stream", () => {
      const body = "event: tick\ndata: {}\n\n".repeat(400);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    })
    .wrap(
      (fetch) => (request: Request, ...rest: unknown[]) =>
        Promise.resolve(fetch(request, ...rest)).then((response) =>
          gzipResponse(request, response),
        ),
    );
}

/** A request that offers gzip. */
function gzipRequest(path: string): Request {
  return new Request(`http://x${path}`, { headers: { "accept-encoding": "gzip" } });
}

describe("acceptsGzip", () => {
  test("an absent header is not consent", () => {
    expect(acceptsGzip(null)).toBe(false);
  });

  test("a bare gzip offer is accepted", () => {
    expect(acceptsGzip("gzip")).toBe(true);
  });

  test("gzip is found among other encodings", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("deflate, gzip;q=1.0")).toBe(true);
  });

  test("an explicit q=0 is a refusal, not an offer", () => {
    // The whole reason the q-value is parsed rather than substring-matched.
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("gzip;q=0.0")).toBe(false);
    expect(acceptsGzip("br, gzip;q=0")).toBe(false);
  });

  test("a positive q-value is accepted", () => {
    expect(acceptsGzip("gzip;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=1")).toBe(true);
  });

  test("a wildcard is not an offer of gzip", () => {
    // `*` means "any encoding I did not name", so it cannot be read as consent
    // to this specific one.
    expect(acceptsGzip("*")).toBe(false);
    expect(acceptsGzip("*;q=1")).toBe(false);
  });

  test("encodings that are not gzip are refused", () => {
    expect(acceptsGzip("br, deflate")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
  });

  test("the token is matched case-insensitively and tolerates spaces", () => {
    expect(acceptsGzip("GZIP")).toBe(true);
    expect(acceptsGzip("gzip ;q=0.5")).toBe(true);
    expect(acceptsGzip(" gzip , deflate")).toBe(true);
  });

  test("a malformed q-value does not grant consent by accident", () => {
    // `Number("abc")` is NaN, so the offer is not honored. Falling back to
    // "compress anyway" would be the wrong direction for an unparseable value.
    expect(acceptsGzip("gzip;q=abc")).toBe(false);
  });
});

describe("isCompressible", () => {
  test("the threshold is 1 KiB", () => {
    expect(MIN_COMPRESSIBLE_BYTES).toBe(1024);
  });

  test("a body at the threshold is compressed, one below is not", () => {
    expect(isCompressible("application/json", MIN_COMPRESSIBLE_BYTES)).toBe(true);
    expect(isCompressible("application/json", MIN_COMPRESSIBLE_BYTES - 1)).toBe(false);
  });

  test("JSON is compressible with or without a charset parameter", () => {
    expect(isCompressible("application/json", 5000)).toBe(true);
    expect(isCompressible("application/json;charset=utf-8", 5000)).toBe(true);
  });

  test("an event stream is never compressible", () => {
    // The gate that keeps a live completion from being buffered.
    expect(isCompressible("text/event-stream", 500_000)).toBe(false);
    expect(isCompressibleType("text/event-stream")).toBe(false);
  });

  test("a binary type is not compressible", () => {
    expect(isCompressible("image/png", 500_000)).toBe(false);
  });

  test("an absent content type is not compressible", () => {
    expect(isCompressible(null, 5000)).toBe(false);
  });

  test("the content type is matched case-insensitively", () => {
    expect(isCompressible("Application/JSON", 5000)).toBe(true);
  });
});

describe("gzipResponse end to end", () => {
  test("a large JSON response is gzipped and decodes back to the same value", async () => {
    const app = compressedApp();
    const response = await app.handle(gzipRequest("/big"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");

    const compressed = new Uint8Array(await response.arrayBuffer());
    const decoded = new TextDecoder().decode(Bun.gunzipSync(compressed));
    const parsed = JSON.parse(decoded) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(500);
  });

  test("the compressed body is dramatically smaller", async () => {
    const app = compressedApp();
    const gzipped = await app.handle(gzipRequest("/big"));
    const raw = await app.handle(new Request("http://x/big"));

    const gzippedBytes = (await gzipped.arrayBuffer()).byteLength;
    const rawBytes = (await raw.arrayBuffer()).byteLength;
    expect(rawBytes).toBeGreaterThan(10_000);
    // Asserted as a ratio rather than a byte count so the test does not break
    // when the fixture's wording changes.
    expect(gzippedBytes).toBeLessThan(rawBytes * 0.1);
  });

  test("the declared content-length matches the compressed body", async () => {
    const app = compressedApp();
    const response = await app.handle(gzipRequest("/big"));
    const bytes = (await response.arrayBuffer()).byteLength;
    expect(Number(response.headers.get("content-length"))).toBe(bytes);
  });

  test("vary is set so a cache cannot serve gzip to a client that did not ask", async () => {
    const app = compressedApp();
    const response = await app.handle(gzipRequest("/big"));
    expect(response.headers.get("vary")).toContain("accept-encoding");
  });

  test("a client that did not offer gzip gets the plain body", async () => {
    const app = compressedApp();
    const response = await app.handle(new Request("http://x/big"));
    expect(response.headers.get("content-encoding")).toBeNull();
    const bytes = (await response.arrayBuffer()).byteLength;
    expect(bytes).toBeGreaterThan(10_000);
  });

  test("a client that refused gzip with q=0 gets the plain body", async () => {
    const app = compressedApp();
    const response = await app.handle(
      new Request("http://x/big", { headers: { "accept-encoding": "gzip;q=0" } }),
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });

  test("a small response is left alone and is not emptied", async () => {
    // The below-threshold path reads the body to measure it, so it must rebuild
    // the response. Returning the original would hand back an empty body.
    const app = compressedApp();
    const response = await app.handle(gzipRequest("/small"));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  test("an event stream is passed through unmodified", async () => {
    // The property the whole content-type gate exists for.
    const app = compressedApp();
    const response = await app.handle(gzipRequest("/stream"));
    expect(response.headers.get("content-encoding")).toBeNull();
    const text = await response.text();
    expect(text).toContain("event: tick");
    expect(text).toContain("data: {}");
  });

  test("a response that is already encoded is not encoded twice", async () => {
    const response = await gzipResponse(
      gzipRequest("/x"),
      new Response("x".repeat(5000), {
        headers: { "content-type": "application/json", "content-encoding": "br" },
      }),
    );
    expect(response.headers.get("content-encoding")).toBe("br");
  });

  test("a HEAD request is not compressed", async () => {
    const response = await gzipResponse(
      new Request("http://x/y", { method: "HEAD", headers: { "accept-encoding": "gzip" } }),
      new Response("x".repeat(5000), { headers: { "content-type": "application/json" } }),
    );
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("a 204 is not compressed", async () => {
    const response = await gzipResponse(gzipRequest("/x"), new Response(null, { status: 204 }));
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("an existing vary is extended rather than replaced", async () => {
    const response = await gzipResponse(
      gzipRequest("/x"),
      new Response(JSON.stringify({ rows: "x".repeat(5000) }), {
        headers: { "content-type": "application/json", vary: "origin" },
      }),
    );
    expect(response.headers.get("vary")).toBe("origin, accept-encoding");
  });

  test("a vary that already names accept-encoding is not duplicated", async () => {
    const response = await gzipResponse(
      gzipRequest("/x"),
      new Response(JSON.stringify({ rows: "x".repeat(5000) }), {
        headers: { "content-type": "application/json", vary: "accept-encoding" },
      }),
    );
    expect(response.headers.get("vary")).toBe("accept-encoding");
  });

  test("a wildcard vary is left as the stronger statement", async () => {
    const response = await gzipResponse(
      gzipRequest("/x"),
      new Response(JSON.stringify({ rows: "x".repeat(5000) }), {
        headers: { "content-type": "application/json", vary: "*" },
      }),
    );
    expect(response.headers.get("vary")).toBe("*");
  });

  test("the response status survives compression", async () => {
    const response = await gzipResponse(
      gzipRequest("/x"),
      new Response(JSON.stringify({ error: "x".repeat(5000) }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(404);
  });
});
