import { describe, expect, test } from "bun:test";
import { TRANSLATION_COMPATIBILITY_FIXTURES, TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";
import { collectReadableStream, decodeSseFrames, sseBody, withFakeFetch } from "./fixtures/helpers";

describe("translation compatibility fixtures", () => {
  test("cover every first-wave CLI and protocol shape", () => {
    const clients = [...new Set(TRANSLATION_COMPATIBILITY_FIXTURES.map((fixture) => fixture.client))].sort();
    expect(clients).toEqual(["claude-code", "cline", "codex", "cursor", "openai-sdk", "opencode"]);
    expect(TRANSLATION_COMPATIBILITY_FIXTURES.every((fixture) => fixture.body.model !== undefined)).toBe(true);
    expect(TRANSLATION_FIXTURE_LIMITS.maxBodyBytes).toBeGreaterThan(1_000_000);
  });

  test("captures fake upstream calls and restores fetch", async () => {
    const originalFetch = globalThis.fetch;
    const result = await withFakeFetch(
      (call) => new Response(JSON.stringify({ url: call.input }), { status: 200, headers: { "content-type": "application/json" } }),
      async (calls) => {
        const response = await fetch("https://provider.example/v1/responses", { method: "POST", body: "{}" });
        return { calls, body: await response.json() };
      },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.input).toBe("https://provider.example/v1/responses");
    expect(result.body).toEqual({ url: "https://provider.example/v1/responses" });
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test("collects and decodes SSE fixture frames without reordering", async () => {
    const chunks = await collectReadableStream(sseBody(['{"type":"response.created"}', "[DONE]"]));
    expect(decodeSseFrames(chunks)).toEqual([
      'data: {"type":"response.created"}',
      "data: [DONE]",
    ]);
  });
});
