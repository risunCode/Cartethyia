import { describe, expect, test } from "bun:test";
import { buildPayloadRecord } from "../../src/observability/payload-capture";

describe("payload capture", () => {
  test("records tool calls, images, and attachments across the captured exchange", () => {
    const record = buildPayloadRecord(
      {
        tenantId: "tenant-1",
        requestId: "request-1",
        requestBody: {
          messages: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: "data:image/png;base64,abc" },
                { type: "file", file_id: "file-1" },
              ],
            },
          ],
          tools: [{ type: "function", function: { name: "bash" } }],
        },
        responseBody: {
          choices: [
            {
              message: {
                tool_calls: [{ id: "call-1", type: "function" }],
              },
            },
          ],
        },
        scope: "tenant",
        tenantOptIn: true,
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(record.signals).toEqual({ toolCalls: 1, images: 1, attachments: 1 });
  });

  test("a maxBytes override truncates combined bodies past the cap", () => {
    const input = {
      tenantId: "tenant-1",
      requestId: "request-1",
      requestBody: { prompt: "x".repeat(1000) },
      responseBody: { text: "y".repeat(1000) },
      scope: "tenant" as const,
      tenantOptIn: true,
    };
    const kept = buildPayloadRecord(input, new Date("2026-01-01T00:00:00.000Z"), 10_000_000);
    expect(kept.request_body).toEqual({ prompt: "x".repeat(1000) });
    const truncated = buildPayloadRecord(input, new Date("2026-01-01T00:00:00.000Z"), 10);
    expect(truncated.request_body).toEqual({
      _truncated: true,
      _original_bytes: expect.any(Number),
      _hint: expect.stringContaining("Capture depth"),
    });
    expect(truncated.response_body).toEqual({
      _truncated: true,
      _original_bytes: expect.any(Number),
      _hint: expect.stringContaining("Capture depth"),
    });
  });
});
