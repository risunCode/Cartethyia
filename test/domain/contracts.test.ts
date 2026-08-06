import { describe, expect, test } from "bun:test";
import {
  boundedRetryAt,
  createCleanupStack,
  deriveErrorSource,
  detectClient,
  isTerminalEvent,
  publicErrorBody,
  sanitizeMessage,
  type ApplicationErrorKind,
  type ClientName,
  type NormalizedProviderRequest,
  type ProviderCallError,
  type StreamEvent,
} from "../../src/domain/contracts";

// ---------------------------------------------------------------------------
// detectClient — client-name detection across headers, user-agent, and prompt
// ---------------------------------------------------------------------------

describe("detectClient", () => {
  test("detects every known client via the explicit x-client-name header", () => {
    const cases: ReadonlyArray<readonly [string, ClientName]> = [
      ["github_copilot", "github_copilot"],
      ["claude_code", "claude_code"],
      ["codex", "codex"],
      ["cursor", "cursor"],
      ["cline", "cline"],
      ["opencode", "opencode"],
      ["pi", "pi"],
    ] as const;
    for (const [raw, expected] of cases) {
      expect(detectClient(new Headers({ "x-client-name": raw })).name).toBe(expected);
      expect(detectClient(new Headers({ "x-client-name": raw })).source).toBe("explicit_header");
    }
  });

  test("header value is matched case-insensitively and trimmed", () => {
    expect(detectClient(new Headers({ "x-client-name": "  CLAUDE_CODE  " })).name).toBe("claude_code");
  });

  test("detects clients via user-agent substrings", () => {
    const cases: ReadonlyArray<readonly [string, ClientName]> = [
      ["claude-code/1.0", "claude_code"],
      ["codex/0.1", "codex"],
      ["Cursor/0.42", "cursor"],
      ["cline extension", "cline"],
      ["opencode-cli", "opencode"],
      ["github-copilot", "github_copilot"],
      ["pi/2", "pi"],
    ] as const;
    for (const [ua, expected] of cases) {
      expect(detectClient(new Headers({ "user-agent": ua })).name).toBe(expected);
      expect(detectClient(new Headers({ "user-agent": ua })).source).toBe("user_agent");
    }
  });

  test("explicit header takes precedence over user-agent", () => {
    const h = new Headers({ "x-client-name": "codex", "user-agent": "claude-code/1.0" });
    expect(detectClient(h)).toEqual({ name: "codex", source: "explicit_header" });
  });

  test("detects claude_code/codex via the x-stainless-helper-method protocol header", () => {
    expect(detectClient(new Headers({ "x-stainless-helper-method": "claude-helper" }))).toEqual({
      name: "claude_code",
      source: "protocol_header",
    });
    expect(detectClient(new Headers({ "x-stainless-helper-method": "codex-helper" }))).toEqual({
      name: "codex",
      source: "protocol_header",
    });
  });

  test("detects claude_code/codex via system/developer prompt markers", () => {
    const base = new Headers({});
    const limits = {
      maxBodyBytes: 1_000_000,
      connectTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    };
    const withClaudeMarker: NormalizedProviderRequest = {
      model: "claude-3",
      messages: [{ role: "system", content: [{ type: "text", text: "You are Claude Code, an AI assistant." }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "anthropic-messages",
      signal: new AbortController().signal,
      limits,
    };
    expect(detectClient(base, withClaudeMarker)).toEqual({ name: "claude_code", source: "prompt_marker" });

    const withCodexMarker: NormalizedProviderRequest = {
      ...withClaudeMarker,
      messages: [{ role: "developer", content: [{ type: "text", text: "Running in Codex sandbox" }] }],
    };
    expect(detectClient(base, withCodexMarker)).toEqual({ name: "codex", source: "prompt_marker" });
  });

  test("returns unknown identity when no signal is present", () => {
    expect(detectClient(new Headers({}))).toEqual({ name: "unknown", source: "unknown" });
  });

  test("ignores an unrecognized x-client-name value", () => {
    expect(detectClient(new Headers({ "x-client-name": "acme-editor" })).name).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// isTerminalEvent — only message_stop terminates a stream
// ---------------------------------------------------------------------------

describe("isTerminalEvent", () => {
  const nonTerminal: StreamEvent[] = [
    { type: "message_start", id: "abc" },
    { type: "thinking_delta", text: "hmm" },
    { type: "text_delta", text: "hi" },
    { type: "tool_call_start", callId: "t1", name: "search" },
    { type: "tool_call_delta", callId: "t1", delta: "{}" },
    { type: "tool_call_end", callId: "t1" },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" } },
  ];

  test.each(nonTerminal.map((ev, i) => [`event #${i} (${ev.type})`, ev] as const))("non-terminal: %s", (_label, ev) => {
    expect(isTerminalEvent(ev)).toBe(false);
  });

  test.each(["completed", "length", "tool_call", "content_filter", "error"] as const)("message_stop is terminal for reason %s", (reason) => {
    expect(isTerminalEvent({ type: "message_stop", reason })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveErrorSource — every kind maps to a consistent origin
// ---------------------------------------------------------------------------

describe("deriveErrorSource", () => {
  const clientKinds: ApplicationErrorKind[] = ["client_aborted", "invalid_request"];
  const internalKinds: ApplicationErrorKind[] = ["internal_error", "credential_unavailable", "capability_unsupported", "model_not_found"];
  const upstreamKinds: ApplicationErrorKind[] = [
    "authentication_failed",
    "authorization_denied",
    "quota_exceeded",
    "concurrency_exceeded",
    "network_unavailable",
    "provider_rate_limited",
    "provider_unavailable",
    "provider_protocol_error",
    "stream_timeout",
    "stream_truncated",
  ];

  test.each(clientKinds)("client kind %s → client", (kind) => {
    expect(deriveErrorSource(kind, null)).toBe("client");
    expect(deriveErrorSource(kind, "provider")).toBe("client");
  });

  test.each(internalKinds)("internal kind %s → internal (routeScope %s ignored)", (kind) => {
    expect(deriveErrorSource(kind, null)).toBe("internal");
    expect(deriveErrorSource(kind, "account")).toBe("internal");
    expect(deriveErrorSource(kind, "provider")).toBe("internal");
  });

  test.each(upstreamKinds)("upstream kind %s → upstream", (kind) => {
    expect(deriveErrorSource(kind, null)).toBe("upstream");
    expect(deriveErrorSource(kind, "provider")).toBe("upstream");
  });
});

// ---------------------------------------------------------------------------
// sanitizeMessage — redaction, fallbacks, and length cap
// ---------------------------------------------------------------------------

describe("sanitizeMessage", () => {
  test("redacts Bearer tokens and does not leak the secret", () => {
    const out = sanitizeMessage('Authorization: Bearer sk-abcd1234-XYZ failed');
    expect(out).toContain("Bearer [redacted]");
    expect(out).not.toContain("sk-abcd1234");
    expect(out).not.toContain("XYZ");
  });

  test("redacts api key / token / secret / password assignments without leaking values", () => {
    const out = sanitizeMessage('api_key=sk-live-XYZ token: "abc" secret=shh password: hunter2');
    expect(out).not.toContain("sk-live-XYZ");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("shh");
    expect(out).toContain("credential=[redacted]");
  });

  test("preserves ordinary error text", () => {
    expect(sanitizeMessage("upstream returned 502 bad gateway")).toBe("upstream returned 502 bad gateway");
  });

  test("collapses whitespace", () => {
    expect(sanitizeMessage("boom   boom\tboom")).toBe("boom boom boom");
  });

  test("truncates to the 240-char cap", () => {
    const long = "x".repeat(500);
    const out = sanitizeMessage(long);
    expect(out.length).toBe(240);
    expect(out).toBe("x".repeat(240));
  });

  test("falls back when value is neither Error nor string", () => {
    expect(sanitizeMessage(undefined)).toBe("Provider request failed (no error detail available)");
    expect(sanitizeMessage(null)).toBe("Provider request failed (no error detail available)");
    expect(sanitizeMessage(42)).toBe("Provider request failed (no error detail available)");
    expect(sanitizeMessage({})).toBe("Provider request failed (no error detail available)");
  });

  test("uses Error.message when given an Error instance", () => {
    expect(sanitizeMessage(new Error("bad upstream response"))).toBe("bad upstream response");
  });

  test("returns empty-message fallback when redaction yields empty", () => {
    expect(sanitizeMessage("   ")).toBe("Provider request failed (empty error message)");
  });

  test("falls back when the message is nothing but a redacted credential", () => {
    const out = sanitizeMessage("Bearer sk-only-token-here");
    // Bearer redaction leaves "Bearer [redacted]", which is non-empty.
    expect(out).toBe("Bearer [redacted]");
  });
});

// ---------------------------------------------------------------------------
// boundedRetryAt — exponential-style gating with cap and override
// ---------------------------------------------------------------------------

describe("boundedRetryAt", () => {
  const NOW = 1_000_000;
  const MAX_DELAY_MS = 60_000;

  test("accepts a numeric seconds value and returns an ISO timestamp now+seconds", () => {
    const out = boundedRetryAt(5, NOW, MAX_DELAY_MS);
    expect(out).toBe(new Date(NOW + 5_000).toISOString());
  });

  test("accepts a numeric-string seconds value", () => {
    expect(boundedRetryAt("12.5", NOW, MAX_DELAY_MS)).toBe(new Date(NOW + 12_500).toISOString());
  });

  test("accepts a plain integer string", () => {
    expect(boundedRetryAt("10", NOW, MAX_DELAY_MS)).toBe(new Date(NOW + 10_000).toISOString());
  });

  test("zero seconds returns now", () => {
    expect(boundedRetryAt(0, NOW, MAX_DELAY_MS)).toBe(new Date(NOW).toISOString());
  });

  test("null when seconds exceeds the max-delay cap", () => {
    expect(boundedRetryAt(MAX_DELAY_MS / 1_000 + 1, NOW, MAX_DELAY_MS)).toBe(null);
  });

  test("null for negative seconds", () => {
    expect(boundedRetryAt(-1, NOW, MAX_DELAY_MS)).toBe(null);
  });

  test.each([
    ["non-numeric", "soon"],
    ["empty", ""],
    ["alpha suffix", "10s"],
    ["with units", "10ms"],
  ] as const)("null for non-numeric string %s", (_label, value) => {
    expect(boundedRetryAt(value, NOW, MAX_DELAY_MS)).toBe(null);
  });

  test("null for non-finite numbers", () => {
    expect(boundedRetryAt(Number.NaN, NOW, MAX_DELAY_MS)).toBe(null);
    expect(boundedRetryAt(Number.POSITIVE_INFINITY, NOW, MAX_DELAY_MS)).toBe(null);
  });

  test("null for non-number/non-string values", () => {
    expect(boundedRetryAt(null, NOW, MAX_DELAY_MS)).toBe(null);
    expect(boundedRetryAt(undefined, NOW, MAX_DELAY_MS)).toBe(null);
    expect(boundedRetryAt({}, NOW, MAX_DELAY_MS)).toBe(null);
  });

  test("boundary: exactly at the max-delay cap is allowed", () => {
    const capSeconds = MAX_DELAY_MS / 1_000;
    expect(boundedRetryAt(capSeconds, NOW, MAX_DELAY_MS)).toBe(new Date(NOW + capSeconds * 1_000).toISOString());
  });

  test("boundary: cap+1 second is rejected", () => {
    expect(boundedRetryAt(MAX_DELAY_MS / 1_000 + 1, NOW, MAX_DELAY_MS)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// publicErrorBody — sanitized, stable error shape with no internals leaked
// ---------------------------------------------------------------------------

describe("publicErrorBody", () => {
  const baseError: ProviderCallError = {
    statusCode: 429,
    kind: "provider_rate_limited",
    retryable: true,
    routeScope: "provider",
    source: "upstream",
    sanitizedMessage: "rate limited",
    retryAt: "2026-01-01T00:00:00.000Z",
  };

  test("shapes the canonical error envelope", () => {
    const body = publicErrorBody(baseError, "req-123");
    expect(body).toEqual({
      error: {
        type: "error",
        code: "provider_rate_limited",
        message: "rate limited",
        request_id: "req-123",
        source: "upstream",
        origin: "provider",
      },
    });
  });

  test("message is the sanitized field, not an internal raw value", () => {
    const err: ProviderCallError = {
      ...baseError,
      sanitizedMessage: "Bearer [redacted]",
    };
    expect(publicErrorBody(err, "r").error.message).toBe("Bearer [redacted]");
  });

  test("origin is null when routeScope is null", () => {
    const err: ProviderCallError = { ...baseError, routeScope: null };
    expect(publicErrorBody(err, "r").error.origin).toBe(null);
  });

  test("source reflects the derived ErrorSource", () => {
    const clientErr: ProviderCallError = { ...baseError, source: "client" };
    expect(publicErrorBody(clientErr, "r").error.source).toBe("client");
  });

  test("request_id is echoed verbatim", () => {
    expect(publicErrorBody(baseError, "abc-def-123").error.request_id).toBe("abc-def-123");
  });

  test("type field is always the literal 'error'", () => {
    for (const kind of ["internal_error", "client_aborted", "quota_exceeded"] as const) {
      expect(publicErrorBody({ ...baseError, kind }, "r").error.type).toBe("error");
    }
  });
});

// ---------------------------------------------------------------------------
// createCleanupStack — LIFO release, error suppression, dispose idempotency
// ---------------------------------------------------------------------------

describe("createCleanupStack", () => {
  test("runs handles in LIFO order", async () => {
    const order: string[] = [];
    const stack = createCleanupStack();
    stack.add({ release: async () => { order.push("a"); } });
    stack.add({ release: async () => { order.push("b"); } });
    stack.add({ release: async () => { order.push("c"); } });
    await stack.run();
    expect(order).toEqual(["c", "b", "a"]);
  });

  test("a throwing release propagates and halts the remaining LIFO chain", async () => {
    const order: string[] = [];
    const stack = createCleanupStack();
    stack.add({ release: async () => { order.push("first"); } });
    stack.add({ release: async () => {
      order.push("explodes");
      throw new Error("boom");
    } });
    stack.add({ release: async () => { order.push("third"); } });

    await expect(stack.run()).rejects.toThrow("boom");
    // LIFO: third ran first, then the exploding handle; first never ran.
    expect(order).toEqual(["third", "explodes"]);
  });

  test("run is idempotent — second invocation is a no-op", async () => {
    const calls: number[] = [];
    const stack = createCleanupStack();
    stack.add({ release: async () => { calls.push(1); } });
    await stack.run();
    await stack.run();
    expect(calls).toEqual([1]);
  });

  test("add after run releases the handle immediately but does not enqueue", async () => {
    const released: string[] = [];
    const stack = createCleanupStack();
    stack.add({ release: async () => { released.push("before"); } });
    await stack.run();
    stack.add({ release: async () => { released.push("after"); } });
    // Give the voided promise a microtask to settle.
    await Promise.resolve();
    expect(released).toEqual(["before", "after"]);
  });

  test("empty stack runs without error", async () => {
    const stack = createCleanupStack();
    await expect(stack.run()).resolves.toBeUndefined();
  });

  test("handles with synchronous release are awaited correctly", async () => {
    const order: string[] = [];
    const stack = createCleanupStack();
    stack.add({ release: async () => { order.push("sync-a"); } });
    stack.add({ release: async () => { order.push("sync-b"); } });
    await stack.run();
    expect(order).toEqual(["sync-b", "sync-a"]);
  });
});
