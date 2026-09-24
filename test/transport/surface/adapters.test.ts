import { describe, expect, test } from "bun:test";
import { SurfaceAdapterRegistry, type SurfaceInput } from "../../../src/transport/surface/adapters";
import { parseToolDefinition } from "../../../src/transport/surface/dialects";
import { formatSseData, formatSseEvent } from "../../../src/transport/surface/stream-frame";
import { chatAdapter } from "../../../src/transport/surface/chat/adapter";
import { responsesAdapter } from "../../../src/transport/surface/responses/adapter";
import { messagesAdapter } from "../../../src/transport/surface/messages/adapter";

const adapters = [chatAdapter, responsesAdapter, messagesAdapter];

function input(overrides: Partial<SurfaceInput> = {}): SurfaceInput {
  return {
    headers: {},
    body: { messages: [{ role: "user", content: "hello" }] },
    path: "/v1/chat/completions",
    ...overrides,
  };
}

describe("SurfaceAdapterRegistry.detectOnce", () => {
  test("uses explicit marker before every lower-precedence signal", () => {
    const detection = new SurfaceAdapterRegistry(adapters).detectOnce(
      input({
        headers: { "x-cartethyia-surface": "responses", "user-agent": "openai/1" },
      }),
    );
    expect(detection).toMatchObject({ surface: "responses", winning_source: "explicit_marker" });
    // The losing signals are still recorded: a marker that contradicts the path
    // is the case worth surfacing, and it is invisible from the winner alone.
    expect(new Set(detection.signals.map((s) => s.surface))).toEqual(new Set(["responses", "chat"]));
    expect(detection.disagreement).toBe(true);
  });

  test("endpoint path wins over user-agent and body shape", () => {
    const detection = new SurfaceAdapterRegistry(adapters).detectOnce(
      input({
        headers: { "user-agent": "codex/1" },
        path: "/v1/messages",
      }),
    );
    expect(detection).toMatchObject({ surface: "messages", winning_source: "endpoint_path" });
  });

  test("ignores user-agent entirely when path and body agree", () => {
    const detection = new SurfaceAdapterRegistry(adapters).detectOnce(
      input({
        headers: { "user-agent": "codex/1" },
        path: "/v1/chat/completions",
      }),
    );
    expect(detection).toMatchObject({ surface: "chat", winning_source: "endpoint_path" });
  });

  test("uses exactly one body-shape match when path is unknown", () => {
    const detection = new SurfaceAdapterRegistry(adapters).detectOnce(
      input({
        body: { input: [{ type: "message" }] },
        path: "/unknown",
      }),
    );
    expect(detection).toMatchObject({ surface: "responses", winning_source: "body_shape" });
  });

  test("never scans prompt content for markers: path decides", () => {
    const detection = new SurfaceAdapterRegistry(adapters).detectOnce(
      input({
        body: { messages: [{ role: "user", content: "__cartethyia_surface:responses__" }] },
        path: "/v1/messages",
      }),
    );
    expect(detection).toMatchObject({ surface: "messages", winning_source: "endpoint_path" });
  });

  test("falls back to chat when nothing matches", () => {
    const detection = new SurfaceAdapterRegistry(adapters).detectOnce(
      input({
        headers: { "user-agent": "unknown-client/42" },
        body: { messages: [{ role: "user", content: "hello" }] },
        path: "/v1/chat/completions",
      }),
    );
    expect(detection.surface).toBe("chat");
    expect(detection.winning_source).toBe("endpoint_path");
  });
});

describe("parseToolDefinition — chat dialect", () => {
  test("parses the standard OpenAI function wrapper shape", () => {
    expect(
      parseToolDefinition(
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
            strict: true,
          },
        },
        "chat",
      ),
    ).toMatchObject({
      name: "get_weather",
      description: "Get the weather",
      jsonSchema: { type: "object" },
      strict: true,
      tool_type: "function",
    });
  });

  test("prefers the wrapper name when both levels are present", () => {
    // The chat dialect nests identity under `function`; that wrapper is the
    // spec-authoritative name, so a stray top-level duplicate must not win.
    expect(
      parseToolDefinition({ type: "function", name: "top", function: { name: "nested" } }, "chat"),
    ).toMatchObject({ name: "nested" });
  });

  test("parses nested custom tools instead of dropping them", () => {
    expect(
      parseToolDefinition(
        {
          type: "custom",
          custom: { name: "do_thing", description: "Does it", format: { type: "text" } },
        },
        "chat",
      ),
    ).toMatchObject({ name: "do_thing", tool_type: "custom" });
  });

  test("drops tools with no name anywhere", () => {
    expect(parseToolDefinition({ type: "function", function: {} }, "chat")).toBeUndefined();
    expect(parseToolDefinition({ type: "function" }, "chat")).toBeUndefined();
    expect(parseToolDefinition("nope", "chat")).toBeUndefined();
  });

  test("end-to-end: chat ingress keeps standard tools for the upstream payload", () => {
    const canonical = chatAdapter.parse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      stream: false,
    });
    expect(canonical.tools?.map((t) => t.name)).toEqual(["get_weather"]);
  });
});

describe("stream-frame", () => {
  test("formatSseData encodes string data directly", () => {
    const bytes = formatSseData("[DONE]");
    expect(new TextDecoder().decode(bytes)).toBe("data: [DONE]\n\n");
  });

  test("formatSseData encodes JSON object data", () => {
    const obj = { foo: "bar", num: 42 };
    expect(new TextDecoder().decode(formatSseData(obj))).toBe(`data: ${JSON.stringify(obj)}\n\n`);
  });

  test("formatSseEvent encodes event name and JSON object", () => {
    const obj = { type: "test_event", delta: "abc" };
    expect(new TextDecoder().decode(formatSseEvent("test_event", obj))).toBe(
      `event: test_event\ndata: ${JSON.stringify(obj)}\n\n`,
    );
  });

  test("formatSseEvent encodes event name and string payload", () => {
    expect(new TextDecoder().decode(formatSseEvent("ping", "pong"))).toBe(
      "event: ping\ndata: pong\n\n",
    );
  });
});
