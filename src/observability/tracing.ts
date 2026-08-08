import { createCleanupStack } from "../application/contracts";

/**
 * Minimal W3C Trace Context propagation (traceparent, tracestate).
 * Compatible with OpenTelemetry and standard tracing systems.
 */

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: string;
}

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const TRACE_ID_ZERO = "0".repeat(32);
const SPAN_ID_ZERO = "0".repeat(16);

/** Generates a random 32-char hex trace ID (128-bit). */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generates a random 16-char hex span ID (64-bit). */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Creates a new root trace context. */
export function createTraceContext(traceFlags = 1): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags,
  };
}

/** Creates a child span context from a parent. */
export function createChildSpanContext(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    traceFlags: parent.traceFlags,
    traceState: parent.traceState,
  };
}

/** Parses a `traceparent` header value. */
export function parseTraceParent(header: string): TraceContext | null {
  const match = header.match(TRACEPARENT_REGEX);
  if (!match) return null;
  const version = match[1];
  const traceId = match[2];
  const spanId = match[3];
  const traceFlags = match[4];
  if (version === undefined || traceId === undefined || spanId === undefined || traceFlags === undefined) return null;
  if (version !== "00") return null; // Only version 00 supported
  if (traceId === TRACE_ID_ZERO || spanId === SPAN_ID_ZERO) return null;
  return {
    traceId,
    spanId,
    traceFlags: parseInt(traceFlags, 16),
    traceState: undefined,
  };
}

/** Formats a trace context as a `traceparent` header value. */
export function formatTraceParent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags.toString(16).padStart(2, "0")}`;
}

/** Extracts trace context from incoming headers. */
export function extractTraceContext(headers: Headers | Record<string, string | undefined>): TraceContext | null {
  const getHeader = (name: string) => {
    if (headers instanceof Headers) return headers.get(name);
    return headers[name.toLowerCase()];
  };

  const traceParent = getHeader("traceparent");
  if (traceParent) {
    const parsed = parseTraceParent(traceParent);
    if (parsed) {
      const traceState = getHeader("tracestate");
      if (typeof traceState === "string") {
        return { ...parsed, traceState };
      }
      return parsed;
    }
  }
  return null;
}

/** Injects trace context into outgoing headers. */
export function injectTraceContext(ctx: TraceContext, headers: Headers | Record<string, string>): void {
  const setHeader = (name: string, value: string) => {
    if (headers instanceof Headers) {
      headers.set(name, value);
    } else {
      headers[name.toLowerCase()] = value;
    }
  };

  setHeader("traceparent", formatTraceParent(ctx));
  const traceState = ctx.traceState;
  if (typeof traceState === "string") {
    setHeader("tracestate", traceState);
  }
}

/** Trace context carrier for async context propagation. */
export class TraceContextCarrier {
  private ctx: TraceContext | null = null;

  set(context: TraceContext): void {
    this.ctx = context;
  }

  get(): TraceContext | null {
    return this.ctx;
  }

  /** Runs a function with this trace context as the current one. */
  run<T>(fn: () => T): T {
    const prev = TraceContextCarrier.current;
    TraceContextCarrier.current = this;
    try {
      return fn();
    } finally {
      TraceContextCarrier.current = prev;
    }
  }

  static current: TraceContextCarrier | null = null;

  /** Gets the current trace context from the carrier stack. */
  static getCurrent(): TraceContext | null {
    return TraceContextCarrier.current?.get() ?? null;
  }

  /** Creates a child span and runs a function with it as current. */
  static runWithChildSpan<T>(fn: (childCtx: TraceContext) => T): T {
    const parent = this.getCurrent() ?? createTraceContext();
    const child = createChildSpanContext(parent);
    const carrier = new TraceContextCarrier();
    carrier.set(child);
    return carrier.run(() => fn(child));
  }
}

/** Trace context bound to a request lifecycle. */
export interface RequestTrace {
  readonly context: TraceContext;
  readonly startTime: number;
  readonly attributes: Map<string, string | number | boolean>;
  addAttribute(key: string, value: string | number | boolean): void;
  setStatus(code: number, message?: string): void;
  end(): void;
}

function createRequestTrace(ctx: TraceContext): RequestTrace {
  const startTime = performance.now();
  const attributes = new Map<string, string | number | boolean>();
  let ended = false;
  let statusCode = 0;
  let statusMessage = "";

  return {
    context: ctx,
    startTime,
    attributes,
    addAttribute(key: string, value: string | number | boolean): void {
      if (!ended) attributes.set(key, value);
    },
    setStatus(code: number, message?: string): void {
      if (!ended) {
        statusCode = code;
        statusMessage = message ?? "";
      }
    },
    end(): void {
      if (ended) return;
      ended = true;
      const durationMs = Math.max(0, Math.round(performance.now() - startTime));
      // In a real implementation, this would export to a tracing backend
      // For now, we just record the span data locally
      // console.debug(`[trace] ${ctx.traceId}/${ctx.spanId} duration=${durationMs}ms status=${statusCode}`);
    },
  };
}

/** Middleware to extract/inject trace context for HTTP requests. */
export function traceMiddleware(
  handler: (request: Request, trace: RequestTrace) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const incoming = extractTraceContext(request.headers);
    const ctx = incoming ?? createTraceContext();
    const trace = createRequestTrace(ctx);

    // Add standard HTTP attributes
    trace.addAttribute("http.method", request.method);
    trace.addAttribute("http.url", request.url);
    trace.addAttribute("http.scheme", new URL(request.url).protocol.replace(":", ""));
    trace.addAttribute("http.target", new URL(request.url).pathname);
    trace.addAttribute("http.host", new URL(request.url).host);
    trace.addAttribute("http.user_agent", request.headers.get("user-agent") ?? "unknown");

    const response = await handler(request, trace);

    trace.addAttribute("http.status_code", response.status);
    trace.addAttribute("http.response_content_length", response.headers.get("content-length") ?? "unknown");
    trace.setStatus(response.status >= 400 ? 2 : 1, response.status >= 400 ? `HTTP ${response.status}` : undefined);
    trace.end();

    // Inject trace context into response headers
    injectTraceContext(ctx, response.headers);
    return response;
  };
}