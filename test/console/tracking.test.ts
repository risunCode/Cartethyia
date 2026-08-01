import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { queryProviderToday, queryUsageRequests, insertUsageHistory } from "../../src/console/db/repos/usage";
import { getRequestDetailBundle } from "../../src/console/db/repos/details";
import { closeRuntimeDbForTests } from "../../src/console/db/runtime-client";
import { patchRuntimeSettings, ensureSettings } from "../../src/console/db/repos/settings";
import { getConsoleEnv } from "../../src/console/env";
import { invalidateRuntimeSettings } from "../../src/console/runtime";
import { useIsolatedDataDir } from "./helpers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

function historyRows(): Record<string, unknown>[] {
  return queryUsageRequests({ limit: 1_000 }).items.reverse().map((row): Record<string, unknown> => ({ ...row }));
}

function dailyRows(): Record<string, unknown>[] {
  return queryProviderToday().map((row) => ({
    ...row,
    input_tokens: row.input,
    output_tokens: row.output,
    cached_tokens: row.cached,
  }));
}

async function waitForPersist(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (historyRows().length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const KIMCHI_USAGE = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };

function mockKimchiJson(): void {
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "kimchi-1",
        object: "chat.completion",
        created: 1234,
        model: "kimi-k2.7",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: KIMCHI_USAGE,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

describe("request tracking", () => {
  test("request history survives a runtime db reconnect (simulated restart)", () => {
    useIsolatedDataDir();
    insertUsageHistory({
      traceId: "persisted-trace", endpoint: "/v1/chat/completions", surface: "chat",
      apiKeyId: null, apiKeyPrefix: "ctk_test", provider: "kimchi", model: "kimchi/kimi-k2.7",
      status: 200, errorKind: null, stream: false,
      startedAt: "2026-07-29 10:00:00", finishedAt: "2026-07-29 10:00:01", durationMs: 12,
      inputTokens: 3, outputTokens: 5, cachedTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 8,
      usageSource: "provider", meta: {},
    });

    // Simulate a process restart: close the cached runtime db handle so the
    // next query reopens runtime.sqlite from disk instead of reusing the live
    // in-memory connection - proves the row is actually durable, not just
    // readable within the same process lifetime.
    closeRuntimeDbForTests();

    const rows = queryUsageRequests({ limit: 10 }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trace_id: "persisted-trace", input_tokens: 3, output_tokens: 5, usage_source: "provider" });
  });

  test("defaults to redacted payload storage and asset metadata tracking", () => {
    const env = getConsoleEnv();
    expect(env.trackPayloads).toBe("store");
    expect(env.trackAssets).toBe("meta");
  });

  test("records a successful qualified request with provider usage", async () => {
    mockKimchiJson();
    const res = await postChat(
      { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer kimchi_test_key" }
    );
    expect(res.status).toBe(200);
    await waitForPersist();

    const rows = historyRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.provider).toBe("kimchi");
    expect(row.model).toBe("kimchi/kimi-k2.7");
    expect(row.endpoint).toBe("/v1/chat/completions");
    expect(row.status).toBe(200);
    expect(row.input_tokens).toBe(2);
    expect(row.output_tokens).toBe(3);
    expect(row.total_tokens).toBe(5);
    expect(row.usage_source).toBe("provider");

    const daily = dailyRows();
    expect(daily.length).toBe(1);
    expect(daily[0]!.requests).toBe(1);
    expect(daily[0]!.input_tokens).toBe(2);

    const detail = getRequestDetailBundle(row.id as number).detail;
    expect(detail?.payload_mode).toBe("store");
    expect(typeof detail?.payload_sha256).toBe("string");
  });

  test("records stream usage captured from terminal SSE frames", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        [
          'data: {"id":"k1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.7","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
          "",
          'data: {"id":"k1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.7","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}',
          "",
          "data: [DONE]",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );

    const res = await postChat(
      { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }], stream: true },
      { authorization: "Bearer kimchi_test_key" }
    );
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so the tracker sees the terminal frame
    await waitForPersist();

    const rows = historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.stream).toBe(1);
    expect(rows[0]!.input_tokens).toBe(4);
    expect(rows[0]!.output_tokens).toBe(6);
  });

  test("records provider auth failures as tracked errors", async () => {
    const res = await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    await waitForPersist();
    const rows = historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe(401);
    expect(rows[0]!.error_kind).toBe("dispatch_error");
  });

  test("payload meta is recorded in meta mode, bodies stay empty", async () => {
    await ensureSettings();
    patchRuntimeSettings({ trackPayloads: "meta" });
    invalidateRuntimeSettings();
    mockKimchiJson();
    const res = await postChat(
      { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer kimchi_test_key" }
    );
    expect(res.status).toBe(200);
    await waitForPersist();

    const detail = getRequestDetailBundle(1).detail;
    expect(detail).not.toBeNull();
    expect(detail!.message_count).toBe(1);
    expect(typeof detail!.payload_sha256).toBe("string");
    expect(detail!.redacted_request).toBeNull();
  });
});
