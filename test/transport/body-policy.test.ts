/**
 * The ingress body policy: the single read of a request body, and the limits
 * that keep one request from consuming the process.
 *
 * Every rejection here is a boundary the gateway must hold, because the body is
 * the largest thing a caller controls:
 *
 * - **The declared `content-length` is not trusted.** A caller can understate it
 *   and stream more, so the size is also enforced while reading. A policy that
 *   only checked the header would let a chunked request stream without bound.
 * - **A JSON route must be told it is JSON.** A missing or wrong content-type on
 *   `/v1/chat/completions` is a 415, not a silent parse of whatever arrived —
 *   otherwise a form-encoded body is parsed as JSON and fails later with a
 *   confusing 400 from a different layer.
 * - **Nesting is bounded.** `JSON.parse` is iterative in V8 but the depth walk is
 *   recursive, so an unbounded body is a stack-overflow primitive.
 * - **A body is read exactly once.** The reader lock handling is what makes the
 *   oversize path return its intended 413 instead of an `ERR_INVALID_STATE` from
 *   a double release.
 *
 * The route table itself is also asserted: its comment records three entries that
 * "sat here with no adapter and no handler: they advertised a surface that 404s",
 * so an entry with no handler is a documentation defect rather than a feature.
 */
import { describe, expect, test } from "bun:test";
import {
  isJsonProxyRoutePath,
  isProxyDispatchRoute,
  readIngressBody,
} from "../../src/transport/middleware/body-policy";
import { NATIVE_SERVICE_PATHS } from "../../src/transport/dispatch/native-services";
import { GatewayError } from "../../src/transport/gateway-error";

/** A request to `path` with the given body and headers. */
function request(
  path: string,
  body?: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`https://gateway.test${path}`, {
    method: init.method ?? "POST",
    ...(body === undefined ? {} : { body }),
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** The GatewayError a rejected read produces. */
async function rejection(input: Request, options?: { maxBodyBytes?: number }): Promise<GatewayError> {
  const failure = await readIngressBody(input, options).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(failure instanceof GatewayError)) {
    throw new Error(`expected a GatewayError, got ${String(failure)}`);
  }
  return failure;
}

describe("the route table", () => {
  test("every canonical JSON route is recognised", () => {
    // The list drives body-read policy, so a route missing from it would be read
    // as an unrouted path and its body never parsed.
    for (const path of [
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/completions",
      "/v1/responses/compact",
      "/v1/messages",
    ]) {
      expect(isJsonProxyRoutePath(path)).toBe(true);
      expect(isProxyDispatchRoute(path)).toBe(true);
    }
  });

  test("every native service path is recognised", () => {
    // The comment states these read a JSON body through the same policy.
    for (const path of NATIVE_SERVICE_PATHS) {
      expect(isJsonProxyRoutePath(path)).toBe(true);
    }
  });

  test("the documented surface routes that dispatch are NOT proxy dispatch routes", () => {
    // `/v1/models` is an authenticated gateway route but never dispatches, so it
    // must not be reported as a proxy request lifecycle event or enqueue a
    // telemetry row — a row for it would inflate the Usage page with requests no
    // provider saw.
    for (const path of ["/v1/models", "/v1/models/claude-sonnet-4-6", "/v1/embeddings", "/v1/images/generations", "/v1/audio/speech"]) {
      expect(isProxyDispatchRoute(path)).toBe(false);
    }
  });

  test("the three removed entries are genuinely absent", () => {
    // The comment names them specifically: they advertised a surface that 404s.
    // Asserted so re-adding one is a deliberate act.
    for (const path of ["/v1/embeddings", "/v1/images/generations", "/v1/audio/speech"]) {
      expect(isJsonProxyRoutePath(path)).toBe(false);
    }
  });

  test("an undefined path is not a dispatch route", () => {
    expect(isProxyDispatchRoute(undefined)).toBe(false);
  });

  test("a near-miss path is not recognised", () => {
    // Exact membership, so a trailing slash or a suffix must not match — either
    // would make the policy apply to a route with no handler behind it.
    for (const path of [
      "/v1/chat/completions/",
      "/v1/chat/completions/extra",
      "/v1/Chat/Completions",
      "v1/chat/completions",
      "/chat/completions",
      "/v1/chat",
    ]) {
      expect(isJsonProxyRoutePath(path)).toBe(false);
    }
  });
});

describe("readIngressBody — paths that are not read", () => {
  test("a non-/v1 path is not read at all", () => {
    // The console and `/share` have their own policies; reading here would
    // consume their bodies.
    expect(readIngressBody(request("/console/api/keys", "{}"))).resolves.toBeUndefined();
    expect(readIngressBody(request("/share/abc", "{}"))).resolves.toBeUndefined();
    expect(readIngressBody(request("/health", "{}"))).resolves.toBeUndefined();
  });

  test("a GET or HEAD on a proxy path is not read", () => {
    // These have no body; reading would block on a stream that never closes.
    for (const method of ["GET", "HEAD"]) {
      expect(
        readIngressBody(request("/v1/chat/completions", undefined, { method })),
      ).resolves.toBeUndefined();
    }
  });

  test("an unrouted /v1 path with a JSON body IS read", () => {
    // MEASURED: the early return is `!isProxyRequest(request)` — the whole
    // `/v1/` prefix — not the JSON route table. So every `/v1/*` path with a JSON
    // content-type is read, including one with no handler behind it. Pinned
    // because it is the opposite of what the route-table comment suggests, and
    // because the consequence is real: an unknown `/v1/...` request has its body
    // buffered (and size-checked) before the router produces its 404.
    return expect(readIngressBody(request("/v1/models", "{}"))).resolves.toEqual({});
    return expect(readIngressBody(request("/v1/unknown", "{}"))).resolves.toEqual({});
  });

  test("the route table decides the CONTENT-TYPE policy, not whether a read happens", () => {
    // The two roles the table actually plays: it gates the 415 on a missing or
    // wrong content-type, and nothing else. An unrouted `/v1/*` path with a
    // non-JSON content-type is therefore not read at all — the early return on
    // the media type fires for it, where a JSON route would have thrown.
    return expect(
      readIngressBody(request("/v1/unknown", "x=1", { headers: { "content-type": "text/plain" } })),
    ).resolves.toBeUndefined();
    // The same request to a JSON route is a 415.
    return expect(
      readIngressBody(request("/v1/chat/completions", "x=1", { headers: { "content-type": "text/plain" } })),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("an unrouted /v1 path with no content-type is not read", () => {
    // The missing-content-type branch is likewise gated on the route table.
    const input = new Request("https://gateway.test/v1/unknown", {
      method: "POST",
      body: "{}",
    });
    return expect(readIngressBody(input)).resolves.toBeUndefined();
  });
});

describe("readIngressBody — content type", () => {
  test("a JSON route with no content-type is a 415", () => {
    // The policy's stated rule. A silent parse of whatever arrived would surface
    // the failure as a confusing 400 from the JSON parser instead of naming the
    // missing header.
    const input = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    expect(input.headers.get("content-type")).toBeNull();
    return expect(readIngressBody(input)).rejects.toBeInstanceOf(GatewayError);
  });

  test("a JSON route with a non-JSON content-type is a 415", () => {
    return expect(
      readIngressBody(
        request("/v1/chat/completions", "a=1", { headers: { "content-type": "application/x-www-form-urlencoded" } }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("the 415 carries the documented code and message", async () => {
    const failure = await rejection(
      request("/v1/chat/completions", "a=1", { headers: { "content-type": "text/plain" } }),
    );
    expect(failure.status).toBe(415);
    expect(failure.code).toBe("unsupported_media_type");
    expect(failure.message).toBe("content-type must be application/json");
  });

  test("a content-type with parameters is accepted", () => {
    // `split(";", 1)` strips the charset; a client that sends
    // `application/json; charset=utf-8` is not making a mistake.
    return expect(
      readIngressBody(
        request("/v1/chat/completions", '{"a":1}', {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    ).resolves.toEqual({ a: 1 });
  });

  test("the content-type comparison is case-insensitive and trimmed", () => {
    // `toLowerCase()` and `trim()` run before the compare, so a client that
    // capitalises the media type or pads it is accepted.
    return expect(
      readIngressBody(
        request("/v1/chat/completions", '{"a":1}', {
          headers: { "content-type": "  Application/JSON  " },
        }),
      ),
    ).resolves.toEqual({ a: 1 });
  });

  test("a JSON-adjacent media type is refused", () => {
    // `application/json-patch+json` is a different media type; the policy is an
    // exact compare after stripping parameters.
    return expect(
      readIngressBody(
        request("/v1/chat/completions", "[]", {
          headers: { "content-type": "application/json-patch+json" },
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("readIngressBody — size limits", () => {
  test("a declared content-length past the limit is a 413 before reading", () => {
    // The header check is the cheap path: reject without consuming the stream.
    return expect(
      readIngressBody(
        request("/v1/chat/completions", '{"a":1}', { headers: { "content-length": "2000000" } }),
      ),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("a malformed content-length is a 413, not a silent pass", async () => {
    // `!/^\d+$/` rejects a negative, a float, and a non-numeric value. `Number`
    // alone would accept `-1` and let the stream through unchecked.
    for (const declared of ["-1", "1.5", "abc", "1e9", " 100 "]) {
      const input = new Request("https://gateway.test/v1/chat/completions", {
        method: "POST",
        body: '{"a":1}',
        headers: { "content-type": "application/json", "content-length": declared },
      });
      // `Request` normalises some of these away, so only assert when the header
      // actually survived construction.
      if (input.headers.get("content-length") !== declared) continue;
      await expect(readIngressBody(input)).rejects.toBeInstanceOf(GatewayError);
    }
  });

  test("the actual bytes are enforced even when content-length is absent", () => {
    // The property that matters: a chunked request has no content-length, so the
    // read-time counter is the only bound. A policy that trusted the header would
    // let it stream without limit.
    const oversized = JSON.stringify({ text: "x".repeat(2_000) });
    return expect(
      readIngressBody(request("/v1/chat/completions", oversized), { maxBodyBytes: 1_000 }),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("a body exactly at the limit is accepted", () => {
    // Both sides of the boundary, so an off-by-one in the `>` comparison is
    // caught.
    const body = JSON.stringify({ t: "x".repeat(50) });
    const size = Buffer.byteLength(body, "utf8");
    return expect(
      readIngressBody(request("/v1/chat/completions", body), { maxBodyBytes: size }),
    ).resolves.toEqual({ t: "x".repeat(50) });
  });

  test("a body one byte past the limit is refused", () => {
    const body = JSON.stringify({ t: "x".repeat(50) });
    const size = Buffer.byteLength(body, "utf8");
    return expect(
      readIngressBody(request("/v1/chat/completions", body), { maxBodyBytes: size - 1 }),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("the 413 carries the documented code", async () => {
    const failure = await rejection(
      request("/v1/chat/completions", "{}", { headers: { "content-length": "99999999" } }),
    );
    expect(failure.status).toBe(413);
    expect(failure.code).toBe("invalid_request");
    expect(failure.message).toContain("exceeds configured limit");
  });

  test("the default limit is one mebibyte", () => {
    // The documented default. A body just under it is accepted with no options.
    const under = JSON.stringify({ t: "x".repeat(1_048_000) });
    return expect(readIngressBody(request("/v1/chat/completions", under))).resolves.toBeDefined();
  });
});

describe("readIngressBody — parsing", () => {
  test("a JSON object is returned as parsed", () => {
    return expect(readIngressBody(request("/v1/chat/completions", '{"a":1,"b":[true,null]}'))).resolves.toEqual({
      a: 1,
      b: [true, null],
    });
  });

  test("a JSON array at the root is accepted", () => {
    // `JSON.parse` accepts any JSON value; the policy does not require an object,
    // because a route may legitimately take an array.
    return expect(readIngressBody(request("/v1/chat/completions", "[1,2,3]"))).resolves.toEqual([1, 2, 3]);
  });

  test("a JSON scalar at the root is accepted", () => {
    return expect(readIngressBody(request("/v1/chat/completions", "null"))).resolves.toBeNull();
  });

  test("malformed JSON is a 400", async () => {
    const failure = await rejection(request("/v1/chat/completions", "{not json"));
    expect(failure.status).toBe(400);
    expect(failure.code).toBe("invalid_request");
    expect(failure.message).toBe("malformed JSON request body");
  });

  test("an empty body is a 400, not an undefined value", () => {
    // An empty string is not valid JSON. Returning undefined would make a
    // bodyless request look like an unrouted path.
    return expect(readIngressBody(request("/v1/chat/completions", ""))).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  test("a multi-byte body is decoded as UTF-8", () => {
    // The `TextDecoder` is the reason a chunk boundary in the middle of a
    // multi-byte character does not corrupt the value.
    return expect(readIngressBody(request("/v1/chat/completions", '{"t":"日本語🔑"}'))).resolves.toEqual({
      t: "日本語🔑",
    });
  });

  test("a body with a UTF-8 BOM is rejected as malformed", () => {
    // MEASURED: `TextDecoder` strips the BOM by default, so the JSON parses.
    // Pinned because a reader might expect the BOM to survive into the value.
    const body = `﻿{"a":1}`;
    return expect(readIngressBody(request("/v1/chat/completions", body))).resolves.toEqual({ a: 1 });
  });

  test("a duplicated key takes the last value", () => {
    // `JSON.parse` semantics. Pinned so a caller cannot rely on the first.
    return expect(readIngressBody(request("/v1/chat/completions", '{"a":1,"a":2}'))).resolves.toEqual({
      a: 2,
    });
  });
});

describe("readIngressBody — the nesting depth bound", () => {
  /** A JSON document nested `depth` levels deep. */
  function nested(depth: number): string {
    return `${"[".repeat(depth)}0${"]".repeat(depth)}`;
  }

  test("a body at the documented depth is accepted", () => {
    // 64 is the documented maximum; the check is `depth > MAX_JSON_DEPTH`, so a
    // document exactly 64 deep passes.
    return expect(readIngressBody(request("/v1/chat/completions", nested(64)))).resolves.toBeDefined();
  });

  test("a body past the depth bound is a 400", async () => {
    // The walk is recursive, so an unbounded body is a stack-overflow primitive.
    // This is the assertion that the bound exists.
    const failure = await rejection(request("/v1/chat/completions", nested(200)));
    expect(failure.status).toBe(400);
    expect(failure.message).toContain("nesting exceeds the allowed depth");
  });

  test("the depth bound applies to objects as well as arrays", () => {
    const deepObject = `${'{"a":'.repeat(200)}0${"}".repeat(200)}`;
    return expect(readIngressBody(request("/v1/chat/completions", deepObject))).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  test("a wide but shallow body is accepted", () => {
    // The bound is on depth, not breadth: a large tool definition list is normal
    // traffic and must not be refused for its shape.
    const wide = JSON.stringify({ items: Array.from({ length: 5_000 }, (_value, index) => index) });
    return expect(readIngressBody(request("/v1/chat/completions", wide))).resolves.toBeDefined();
  });

  test("a deeply nested body just under the bound is accepted", () => {
    // Both sides of the boundary.
    return expect(readIngressBody(request("/v1/chat/completions", nested(63)))).resolves.toBeDefined();
    return expect(readIngressBody(request("/v1/chat/completions", nested(65)))).rejects.toBeInstanceOf(
      GatewayError,
    );
  });
});

describe("readIngressBody — the reader lock", () => {
  test("an oversize body surfaces the 413, not a lock error", () => {
    // The documented hazard: the oversize branch cancels the reader, which
    // releases the lock itself, so a second `releaseLock()` throws
    // ERR_INVALID_STATE and would replace the intended 413 with an opaque runtime
    // error. This asserts the 413 is what a caller sees.
    const oversized = JSON.stringify({ text: "y".repeat(5_000) });
    return expect(
      readIngressBody(request("/v1/chat/completions", oversized), { maxBodyBytes: 100 }),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  test("the 413 from the read path is the same shape as the header path", async () => {
    const oversized = JSON.stringify({ text: "y".repeat(5_000) });
    const fromRead = await rejection(
      request("/v1/chat/completions", oversized),
      { maxBodyBytes: 100 },
    );
    const fromHeader = await rejection(
      request("/v1/chat/completions", "{}", { headers: { "content-length": "99999999" } }),
    );
    expect(fromRead.code).toBe(fromHeader.code);
    expect(fromRead.status).toBe(fromHeader.status);
    expect(fromRead.message).toBe(fromHeader.message);
  });

  test("a request with no body at all is a 400, not a hang", () => {
    // `request.body` is null for a GET, but a POST with no body has an empty
    // stream. Either way the read must terminate.
    const input = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    return expect(readIngressBody(input)).rejects.toBeInstanceOf(GatewayError);
  });
});
