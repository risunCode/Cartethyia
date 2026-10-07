import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTelemetryPayloadMode } from "../../src/console/settings/store";
import { buildPayloadRecord } from "../../src/observability/payload-capture";
import { readPayloadFrame, writePayloadFrame } from "../../src/observability/payload-store";

describe("payload capture", () => {
  test("an unset capture mode is off, not metadata", () => {
    expect(normalizeTelemetryPayloadMode(undefined)).toBe("none");
    expect(normalizeTelemetryPayloadMode("metadata")).toBe("metadata");
    expect(normalizeTelemetryPayloadMode("nope")).toBe("none");
  });

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
      _original_bytes: 0,
      _hint: expect.stringContaining("Capture depth"),
    });
    expect(truncated.response_body).toEqual(truncated.request_body);
  });

  test("a body that fits is kept and only the one past the cap is dropped", () => {
    const record = buildPayloadRecord(
      {
        tenantId: "tenant-1",
        requestId: "request-1",
        requestBody: { prompt: "short" },
        responseBody: { text: "y".repeat(1000) },
        scope: "tenant",
        tenantOptIn: true,
      },
      new Date("2026-01-01T00:00:00.000Z"),
      100,
    );
    expect(record.request_body).toEqual({ prompt: "short" });
    expect(record.response_body).toEqual({
      _truncated: true,
      _original_bytes: expect.any(Number),
      _hint: expect.stringContaining("Capture depth"),
    });
    // Signals count only what was stored. The dropped body is never walked.
    expect(record.signals).toEqual({ toolCalls: 0, images: 0, attachments: 0 });
  });

  test("a frame written from the prebuilt text reads back the same bodies", async () => {
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = mkdtempSync(join(tmpdir(), "cartethyia-payload-"));
    const record = buildPayloadRecord(
      {
        tenantId: "tenant-1",
        requestId: "request-1",
        requestBody: { prompt: "keep me" },
        responseBody: { text: "and me" },
        scope: "tenant",
        tenantOptIn: true,
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const serialized = record._serialized;
    if (serialized === undefined) throw new Error("record carried no prebuilt text");
    const reference = await writePayloadFrame(record, record.expires_at, {
      requestId: record.request_id,
      capturedAt: record.captured_at.toISOString(),
      signals: record.signals,
      bodies: serialized,
    });
    const back = await readPayloadFrame(reference) as {
      request_id?: string;
      request_body?: unknown;
      response_body?: unknown;
    };
    expect(back.request_id).toBe("request-1");
    expect(back.request_body).toEqual({ prompt: "keep me" });
    expect(back.response_body).toEqual({ text: "and me" });
  });
});
