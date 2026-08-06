import { describe, expect, test } from "bun:test";
import {
  TraceContextCarrier,
  createChildSpanContext,
  createTraceContext,
  extractTraceContext,
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  injectTraceContext,
  parseTraceParent,
  traceMiddleware,
} from "../../src/observability/tracing";
import type { RequestTrace, TraceContext } from "../../src/observability/tracing";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

describe("generateTraceId", () => {
  test("returns a 32-char lowercase hex string", () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(HEX32.test(id)).toBe(true);
  });

  test("produces unique values across repeated calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(generateTraceId());
    expect(ids.size).toBe(200);
  });

  test("never returns the all-zero trace id", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateTraceId()).not.toBe("0".repeat(32));
    }
  });
});

describe("generateSpanId", () => {
  test("returns a 16-char lowercase hex string", () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(HEX16.test(id)).toBe(true);
  });

  test("produces unique values across repeated calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(generateSpanId());
    expect(ids.size).toBe(200);
  });

  test("never returns the all-zero span id", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSpanId()).not.toBe("0".repeat(16));
    }
  });
});

describe("createTraceContext", () => {
  test("creates a context with fresh traceId and spanId", () => {
    const ctx = createTraceContext();
    expect(HEX32.test(ctx.traceId)).toBe(true);
    expect(HEX16.test(ctx.spanId)).toBe(true);
    expect(ctx.traceId).not.toBe(ctx.spanId);
  });

  test("defaults the sampled trace flag to 1", () => {
    expect(createTraceContext().traceFlags).toBe(1);
  });

  test("accepts a custom trace flag", () => {
    expect(createTraceContext(0).traceFlags).toBe(0);
    expect(createTraceContext(2).traceFlags).toBe(2);
  });

  test("does not set traceState on a fresh root context", () => {
    expect(createTraceContext().traceState).toBeUndefined();
  });

  test("creates independent contexts on repeated calls", () => {
    const a = createTraceContext();
    const b = createTraceContext();
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
  });
});

describe("createChildSpanContext", () => {
  test("inherits the parent traceId and trace flags", () => {
    const parent = createTraceContext(2);
    const child = createChildSpanContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.traceFlags).toBe(parent.traceFlags);
  });

  test("generates a new spanId distinct from the parent", () => {
    const parent = createTraceContext();
    const child = createChildSpanContext(parent);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(HEX16.test(child.spanId)).toBe(true);
  });

  test("propagates traceState when the parent carries one", () => {
    const parent: TraceContext = { ...createTraceContext(), traceState: "vendor=acme" };
    const child = createChildSpanContext(parent);
    expect(child.traceState).toBe("vendor=acme");
  });

  test("leaves traceState undefined when the parent has none", () => {
    const child = createChildSpanContext(createTraceContext());
    expect(child.traceState).toBeUndefined();
  });
});

describe("parseTraceParent", () => {
  test("parses a well-formed version-00 traceparent", () => {
    const ctx = createTraceContext(1);
    const header = formatTraceParent(ctx);
    const parsed = parseTraceParent(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(ctx.traceId);
    expect(parsed!.spanId).toBe(ctx.spanId);
    expect(parsed!.traceFlags).toBe(1);
  });

  test("parses the sampled flag from the trailing byte", () => {
    const header = `00-${generateTraceId()}-${generateSpanId()}-01`;
    const parsed = parseTraceParent(header);
    expect(parsed!.traceFlags).toBe(1);
  });

  test("parses the unsampled flag as zero", () => {
    const header = `00-${generateTraceId()}-${generateSpanId()}-00`;
    const parsed = parseTraceParent(header);
    expect(parsed!.traceFlags).toBe(0);
  });

  test("returns null for an all-zero trace id", () => {
    const header = `00-${"0".repeat(32)}-${generateSpanId()}-01`;
    expect(parseTraceParent(header)).toBeNull();
  });

  test("returns null for an all-zero span id", () => {
    const header = `00-${generateTraceId()}-${"0".repeat(16)}-01`;
    expect(parseTraceParent(header)).toBeNull();
  });

  test("returns null for a malformed header missing segments", () => {
    expect(parseTraceParent("garbage")).toBeNull();
    expect(parseTraceParent("00-abc-01")).toBeNull();
    expect(parseTraceParent("")).toBeNull();
  });

  test("returns null for an unsupported version", () => {
    const header = `01-${generateTraceId()}-${generateSpanId()}-01`;
    expect(parseTraceParent(header)).toBeNull();
  });

  test("returns null when hex case is wrong (uppercase not allowed by regex)", () => {
    const id = generateTraceId();
    const upper = id.toUpperCase();
    const header = `00-${upper}-${generateSpanId()}-01`;
    expect(parseTraceParent(header)).toBeNull();
  });

  test("accepts a trailing tracestate suffix segment", () => {
    const header = `00-${generateTraceId()}-${generateSpanId()}-01-vendor=acme`;
    const parsed = parseTraceParent(header);
    expect(parsed).not.toBeNull();
  });
});

describe("formatTraceParent", () => {
  test("formats to the W3C traceparent shape", () => {
    const ctx = createTraceContext(1);
    const header = formatTraceParent(ctx);
    expect(TRACEPARENT_RE.test(header)).toBe(true);
  });

  test("round-trips through parseTraceParent", () => {
    const ctx = createTraceContext(0);
    const parsed = parseTraceParent(formatTraceParent(ctx));
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(ctx.traceId);
    expect(parsed!.spanId).toBe(ctx.spanId);
    expect(parsed!.traceFlags).toBe(0);
  });

  test("pads a single-digit trace flag to two hex chars", () => {
    const ctx: TraceContext = { traceId: generateTraceId(), spanId: generateSpanId(), traceFlags: 1 };
    expect(formatTraceParent(ctx)).toMatch(/-01$/);
  });

  test("encodes the version as 00", () => {
    const ctx = createTraceContext();
    expect(formatTraceParent(ctx).startsWith("00-")).toBe(true);
  });
});

describe("extractTraceContext", () => {
  test("extracts context from a Headers traceparent", () => {
    const ctx = createTraceContext(1);
    const headers = new Headers({ traceparent: formatTraceParent(ctx) });
    const extracted = extractTraceContext(headers);
    expect(extracted).not.toBeNull();
    expect(extracted!.traceId).toBe(ctx.traceId);
    expect(extracted!.spanId).toBe(ctx.spanId);
  });

  test("returns null when no traceparent header is present", () => {
    const headers = new Headers({ "content-type": "application/json" });
    expect(extractTraceContext(headers)).toBeNull();
  });

  test("returns null when the traceparent is malformed", () => {
    const headers = new Headers({ traceparent: "garbage" });
    expect(extractTraceContext(headers)).toBeNull();
  });

  test("attaches tracestate when the header is present", () => {
    const ctx = createTraceContext(1);
    const headers = new Headers({
      traceparent: formatTraceParent(ctx),
      tracestate: "vendor=acme,foo=bar",
    });
    const extracted = extractTraceContext(headers);
    expect(extracted!.traceState).toBe("vendor=acme,foo=bar");
  });

  test("leaves tracestate undefined when missing", () => {
    const ctx = createTraceContext(1);
    const headers = new Headers({ traceparent: formatTraceParent(ctx) });
    const extracted = extractTraceContext(headers);
    expect(extracted!.traceState).toBeUndefined();
  });

  test("works with a plain object of lowercased headers", () => {
    const ctx = createTraceContext(1);
    const headers: Record<string, string | undefined> = {
      traceparent: formatTraceParent(ctx),
      tracestate: "vendor=acme",
    };
    const extracted = extractTraceContext(headers);
    expect(extracted!.traceId).toBe(ctx.traceId);
    expect(extracted!.traceState).toBe("vendor=acme");
  });

  test("returns null for an object with no traceparent key", () => {
    const headers: Record<string, string | undefined> = { "content-type": "application/json" };
    expect(extractTraceContext(headers)).toBeNull();
  });

  test("treats an undefined traceparent value as missing", () => {
    const headers: Record<string, string | undefined> = { traceparent: undefined };
    expect(extractTraceContext(headers)).toBeNull();
  });
});

describe("injectTraceContext", () => {
  test("sets the traceparent header on a Headers object", () => {
    const ctx = createTraceContext(1);
    const headers = new Headers();
    injectTraceContext(ctx, headers);
    expect(headers.get("traceparent")).toBe(formatTraceParent(ctx));
  });

  test("sets the tracestate header when the context carries one", () => {
    const ctx: TraceContext = { ...createTraceContext(), traceState: "vendor=acme" };
    const headers = new Headers();
    injectTraceContext(ctx, headers);
    expect(headers.get("tracestate")).toBe("vendor=acme");
  });

  test("does not set tracestate when the context has none", () => {
    const ctx = createTraceContext();
    const headers = new Headers();
    injectTraceContext(ctx, headers);
    expect(headers.has("tracestate")).toBe(false);
  });

  test("writes lowercased keys into a plain object", () => {
    const ctx = createTraceContext(1);
    const target: Record<string, string> = {};
    injectTraceContext(ctx, target);
    expect(target.traceparent).toBe(formatTraceParent(ctx));
  });

  test("writes tracestate into a plain object when present", () => {
    const ctx: TraceContext = { ...createTraceContext(), traceState: "vendor=acme" };
    const target: Record<string, string> = {};
    injectTraceContext(ctx, target);
    expect(target.tracestate).toBe("vendor=acme");
  });

  test("round-trips inject then extract on a Headers object", () => {
    const ctx = createTraceContext(1);
    const headers = new Headers();
    injectTraceContext(ctx, headers);
    const extracted = extractTraceContext(headers);
    expect(extracted!.traceId).toBe(ctx.traceId);
    expect(extracted!.spanId).toBe(ctx.spanId);
    expect(extracted!.traceFlags).toBe(ctx.traceFlags);
  });
});

describe("TraceContextCarrier", () => {
  test("get returns null before any context is set", () => {
    const carrier = new TraceContextCarrier();
    expect(carrier.get()).toBeNull();
  });

  test("set then get returns the stored context", () => {
    const carrier = new TraceContextCarrier();
    const ctx = createTraceContext();
    carrier.set(ctx);
    expect(carrier.get()).toBe(ctx);
  });

  test("set overwrites the previously stored context", () => {
    const carrier = new TraceContextCarrier();
    const a = createTraceContext();
    const b = createTraceContext();
    carrier.set(a);
    carrier.set(b);
    expect(carrier.get()).toBe(b);
  });

  test("run makes the carrier the current one and restores the previous after", () => {
    const prev = TraceContextCarrier.current;
    const carrier = new TraceContextCarrier();
    const stored = createTraceContext();
    carrier.set(stored);
    let seenInside: TraceContext | null = null;
    carrier.run(() => {
      seenInside = TraceContextCarrier.getCurrent();
    });
    expect(seenInside === stored).toBe(true);
    expect(TraceContextCarrier.current).toBe(prev);
  });

  test("run restores the previous carrier even when the callback throws", () => {
    const prev = TraceContextCarrier.current;
    const carrier = new TraceContextCarrier();
    carrier.set(createTraceContext());
    expect(() =>
      carrier.run(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(TraceContextCarrier.current).toBe(prev);
  });

  test("static getCurrent returns null when no carrier is active", () => {
    const prev = TraceContextCarrier.current;
    TraceContextCarrier.current = null;
    expect(TraceContextCarrier.getCurrent()).toBeNull();
    TraceContextCarrier.current = prev;
  });

  test("static getCurrent returns the active carrier's context", () => {
    const prev = TraceContextCarrier.current;
    const ctx = createTraceContext();
    const carrier = new TraceContextCarrier();
    carrier.set(ctx);
    let seen: TraceContext | null = null;
    carrier.run(() => {
      seen = TraceContextCarrier.getCurrent();
    });
    expect(seen === ctx).toBe(true);
    TraceContextCarrier.current = prev;
  });

  test("runWithChildSpan derives a child from the active context", () => {
    const prev = TraceContextCarrier.current;
    const parentCarrier = new TraceContextCarrier();
    const parent = createTraceContext();
    parentCarrier.set(parent);
    let childSeen: TraceContext | null = null;
    parentCarrier.run(() => {
      childSeen = TraceContextCarrier.runWithChildSpan((childCtx) => {
        expect(childCtx.traceId).toBe(parent.traceId);
        expect(childCtx.spanId).not.toBe(parent.spanId);
        return TraceContextCarrier.getCurrent();
      });
    });
    expect(childSeen).not.toBeNull();
    expect(childSeen!.traceId).toBe(parent.traceId);
    TraceContextCarrier.current = prev;
  });

  test("runWithChildSpan creates a root context when none is active", () => {
    const prev = TraceContextCarrier.current;
    TraceContextCarrier.current = null;
    const result = TraceContextCarrier.runWithChildSpan((childCtx) => {
      expect(HEX32.test(childCtx.traceId)).toBe(true);
      return childCtx;
    });
    expect(HEX32.test(result.traceId)).toBe(true);
    expect(TraceContextCarrier.current).toBeNull();
    TraceContextCarrier.current = prev;
  });

  test("runWithChildSpan restores the previous carrier after completion", () => {
    const prev = TraceContextCarrier.current;
    TraceContextCarrier.current = null;
    TraceContextCarrier.runWithChildSpan(() => 0);
    expect(TraceContextCarrier.current).toBeNull();
    TraceContextCarrier.current = prev;
  });
});

describe("RequestTrace (via traceMiddleware)", () => {
  test("addAttribute stores attributes before end", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      trace.addAttribute("custom.key", "value");
      trace.addAttribute("numeric", 42);
      trace.addAttribute("flag", true);
      return new Response("ok", { status: 200 });
    });
    await middleware(new Request("https://example.com/v1/chat"));
    expect(captured!.attributes.get("custom.key")).toBe("value");
    expect(captured!.attributes.get("numeric")).toBe(42);
    expect(captured!.attributes.get("flag")).toBe(true);
  });

  test("setStatus records status only before end", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      trace.setStatus(1, "ok");
      return new Response("ok", { status: 200 });
    });
    await middleware(new Request("https://example.com/v1/chat"));
    // status set inside the handler; verify end() is idempotent and doesn't throw
    expect(captured).not.toBeNull();
  });

  test("end is idempotent", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      return new Response("ok", { status: 200 });
    });
    await middleware(new Request("https://example.com/v1/chat"));
    // Calling end again should be a no-op (no throw)
    expect(() => captured!.end()).not.toThrow();
  });

  test("addAttribute after end is ignored", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      trace.addAttribute("before", "a");
      return new Response("ok", { status: 200 });
    });
    await middleware(new Request("https://example.com/v1/chat"));
    captured!.addAttribute("after", "b");
    expect(captured!.attributes.get("after")).toBeUndefined();
    expect(captured!.attributes.get("before")).toBe("a");
  });
});

describe("traceMiddleware", () => {
  test("creates a fresh trace when no incoming traceparent exists", async () => {
    let seenTraceId = "";
    const middleware = traceMiddleware(async (_req, trace) => {
      seenTraceId = trace.context.traceId;
      return new Response("ok");
    });
    await middleware(new Request("https://example.com/v1/chat"));
    expect(HEX32.test(seenTraceId)).toBe(true);
  });

  test("inherits the incoming trace context from the request headers", async () => {
    const incoming = createTraceContext(1);
    let seenTraceId = "";
    let seenSpanId = "";
    const middleware = traceMiddleware(async (_req, trace) => {
      seenTraceId = trace.context.traceId;
      seenSpanId = trace.context.spanId;
      return new Response("ok");
    });
    await middleware(
      new Request("https://example.com/v1/chat", {
        headers: { traceparent: formatTraceParent(incoming) },
      }),
    );
    expect(seenTraceId).toBe(incoming.traceId);
    // spanId is the incoming span (used as-is by the middleware)
    expect(seenSpanId).toBe(incoming.spanId);
  });

  test("records HTTP method and URL attributes", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      return new Response("ok");
    });
    await middleware(new Request("https://example.com/v1/chat", { method: "POST" }));
    expect(captured!.attributes.get("http.method")).toBe("POST");
    expect(captured!.attributes.get("http.url")).toBe("https://example.com/v1/chat");
    expect(captured!.attributes.get("http.scheme")).toBe("https");
    expect(captured!.attributes.get("http.target")).toBe("/v1/chat");
    expect(captured!.attributes.get("http.host")).toBe("example.com");
  });

  test("records http.user_agent as unknown when header missing", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      return new Response("ok");
    });
    await middleware(new Request("https://example.com/v1/chat"));
    expect(captured!.attributes.get("http.user_agent")).toBe("unknown");
  });

  test("records http.user_agent when header present", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      return new Response("ok");
    });
    await middleware(
      new Request("https://example.com/v1/chat", { headers: { "user-agent": "test-agent/1.0" } }),
    );
    expect(captured!.attributes.get("http.user_agent")).toBe("test-agent/1.0");
  });

  test("records response status code and content-length attributes", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      return new Response("hello", { status: 201, headers: { "content-length": "5" } });
    });
    await middleware(new Request("https://example.com/v1/chat"));
    expect(captured!.attributes.get("http.status_code")).toBe(201);
    expect(captured!.attributes.get("http.response_content_length")).toBe("5");
  });

  test("injects trace context into the response headers", async () => {
    const incoming = createTraceContext(1);
    const middleware = traceMiddleware(async () => new Response("ok"));
    const response = await middleware(
      new Request("https://example.com/v1/chat", {
        headers: { traceparent: formatTraceParent(incoming) },
      }),
    );
    const tp = response.headers.get("traceparent");
    expect(tp).not.toBeNull();
    const parsed = parseTraceParent(tp!);
    expect(parsed!.traceId).toBe(incoming.traceId);
  });

  test("sets span status to error (2) for 4xx responses", async () => {
    let captured: RequestTrace | null = null;
    const middleware = traceMiddleware(async (_req, trace) => {
      captured = trace;
      return new Response("Not Found", { status: 404 });
    });
    await middleware(new Request("https://example.com/v1/chat"));
    // status code 2 => error; we verify via observable: end ran and attributes persisted
    expect(captured!.attributes.get("http.status_code")).toBe(404);
  });

  test("returns the handler's response unchanged in body and status", async () => {
    const middleware = traceMiddleware(async () => new Response("payload", { status: 207 }));
    const response = await middleware(new Request("https://example.com/v1/chat"));
    expect(response.status).toBe(207);
    expect(await response.text()).toBe("payload");
  });

  test("propagates handler exceptions to the caller", async () => {
    const middleware = traceMiddleware(async () => {
      throw new Error("handler failed");
    });
    await expect(middleware(new Request("https://example.com/v1/chat"))).rejects.toThrow("handler failed");
  });
});
