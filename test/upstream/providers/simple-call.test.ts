import { describe, expect, test } from "bun:test";
import { callSimpleProvider } from "../../../src/upstream/providers/simple-call";
import { ProviderCallError } from "../../../src/upstream/providers";
import { withRetry, DEFAULT_RETRY_CONFIG } from "../../../src/upstream/retry";
import type { StreamEvent } from "../../../src/upstream/bridge";

async function* decodeStream(_body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  yield { type: "finish", stopReason: "end_turn" };
}

function options(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  return {
    url: "https://provider.example/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: { model: "test-model", stream: false },
    signal: AbortSignal.timeout(1_000),
    providerLabel: "Test provider",
    isStreaming: false,
    decodeStream,
    fetcher,
  };
}

describe("callSimpleProvider", () => {
  test("classifies invalid JSON as a retryable malformed upstream response", async () => {
    await expect(
      callSimpleProvider(options(async () => new Response("<html>gateway error</html>", { status: 200 }))),
    ).rejects.toMatchObject({
      status: 502,
      kind: "malformed_response",
      message: "Test provider returned invalid JSON.",
    });
  });

  test("recovers when a transient invalid JSON response succeeds on retry", async () => {
    let calls = 0;
    const result = await withRetry(
      () => callSimpleProvider(options(async () => {
        calls += 1;
        return calls === 1
          ? new Response("truncated", { status: 200 })
          : Response.json({ id: "ok" });
      })),
      { ...DEFAULT_RETRY_CONFIG, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    );

    expect(result).toEqual({ type: "json", body: { id: "ok" } });
    expect(calls).toBe(2);
  });

  test("keeps non-object JSON as a malformed response", async () => {
    await expect(
      callSimpleProvider(options(async () => Response.json([]))),
    ).rejects.toBeInstanceOf(ProviderCallError);
  });
});
