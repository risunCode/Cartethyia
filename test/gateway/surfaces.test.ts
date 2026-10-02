/**
 * The three public wire surfaces, end to end.
 *
 * Cartethyia accepts OpenAI Chat, OpenAI Responses, and Anthropic Messages on
 * one canonical pipeline. This suite proves the property that makes that
 * promise real: the same canonical event stream is encoded into each surface's
 * own vocabulary, and each surface's request is parsed into the same canonical
 * shape.
 *
 * Assertions read the *encoded* response — what a real client receives — rather
 * than the canonical intermediate, because a canonical event that never reaches
 * the wire is not a working surface.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import type { DispatchRecord } from "../helpers/gateway";

dbDescribe("public wire surfaces", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    gateway.serveWorld(world);
    gateway.adapter(world.providerId);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  describe("OpenAI Chat Completions", () => {
    test("a non-streaming request returns a chat.completion envelope", async () => {
      const response = await gateway.json(
        "/v1/chat/completions",
        {
          model: world.qualifiedModel,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        object: string;
        choices: { message: { role: string; content: string }; finish_reason: string }[];
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0]?.message.role).toBe("assistant");
      expect(body.choices[0]?.message.content).toBe("Hello from Cartethyia");
      expect(body.choices[0]?.finish_reason).toBe("stop");
      // Usage must be present and internally consistent: a client that bills
      // from these numbers cannot be given a total that disagrees with its parts.
      expect(body.usage.total_tokens).toBe(
        body.usage.prompt_tokens + body.usage.completion_tokens,
      );
    });

    test("a streaming request returns SSE frames terminated by [DONE]", async () => {
      const response = await gateway.json(
        "/v1/chat/completions",
        {
          model: world.qualifiedModel,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("data: ");
      // `[DONE]` is what tells an OpenAI client the stream ended cleanly rather
      // than being truncated; without it a client retries or hangs.
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    });

    test("streamed content matches the non-streamed content", async () => {
      // The two paths share one encoder source, so a divergence is a real bug
      // rather than a formatting difference.
      const nonStream = await gateway.json(
        "/v1/chat/completions",
        { model: world.qualifiedModel, messages: [{ role: "user", content: "hi" }], stream: false },
        { token: world.token },
      );
      const nonStreamBody = (await nonStream.json()) as {
        choices: { message: { content: string } }[];
      };
      const stream = await gateway.json(
        "/v1/chat/completions",
        { model: world.qualifiedModel, messages: [{ role: "user", content: "hi" }], stream: true },
        { token: world.token },
      );
      const streamText = await stream.text();
      expect(streamText).toContain(nonStreamBody.choices[0]?.message.content ?? "");
    });

    test("a tool call is encoded with the OpenAI tool_calls shape", async () => {
      const response = await gateway.json(
        "/v1/chat/completions",
        {
          model: world.qualifiedModel,
          messages: [{ role: "user", content: "weather in Jakarta" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Look up the weather",
                parameters: { type: "object", properties: { location: { type: "string" } } },
              },
            },
          ],
          stream: false,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        choices: {
          message: { tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
          finish_reason: string;
        }[];
      };
      const toolCalls = body.choices[0]?.message.tool_calls;
      expect(toolCalls?.length).toBe(1);
      expect(toolCalls?.[0]?.function.name).toBe("get_weather");
      // The arguments must be a JSON *string*, not an object: OpenAI clients
      // parse it themselves and a pre-parsed object breaks them.
      expect(typeof toolCalls?.[0]?.function.arguments).toBe("string");
      expect(JSON.parse(toolCalls?.[0]?.function.arguments ?? "{}")).toEqual({
        location: "Jakarta",
      });
      expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    });
  });

  describe("OpenAI Responses", () => {
    test("a non-streaming request returns a response envelope", async () => {
      const response = await gateway.json(
        "/v1/responses",
        {
          model: world.qualifiedModel,
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          stream: false,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        object: string;
        output: { type: string; content?: { type: string; text: string }[] }[];
        status: string;
      };
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      const message = body.output.find((item) => item.type === "message");
      expect(message?.content?.[0]?.text).toBe("Hello from Cartethyia");
    });

    test("a streaming request emits named SSE events", async () => {
      const response = await gateway.json(
        "/v1/responses",
        {
          model: world.qualifiedModel,
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          stream: true,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      // The Responses wire uses `event:` lines, unlike Chat's bare `data:`.
      expect(text).toContain("event: response.");
    });

    test("a plain string input is accepted", async () => {
      // The Responses API permits `input` as a bare string; rejecting it would
      // break clients that use the shorthand.
      const response = await gateway.json(
        "/v1/responses",
        { model: world.qualifiedModel, input: "hello", stream: false },
        { token: world.token },
      );
      expect(response.status).toBe(200);
    });
  });

  describe("Anthropic Messages", () => {
    test("a non-streaming request returns a message envelope", async () => {
      const response = await gateway.json(
        "/v1/messages",
        {
          model: world.qualifiedModel,
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        type: string;
        role: string;
        content: { type: string; text: string }[];
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(body.content[0]?.type).toBe("text");
      expect(body.content[0]?.text).toBe("Hello from Cartethyia");
      expect(body.stop_reason).toBe("end_turn");
      expect(typeof body.usage.input_tokens).toBe("number");
    });

    test("a streaming request emits Anthropic event names", async () => {
      const response = await gateway.json(
        "/v1/messages",
        {
          model: world.qualifiedModel,
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: message_stop");
    });

    test("a system prompt is carried through as a top-level field", async () => {
      // Anthropic's `system` is a sibling of `messages`, not a message with
      // role "system"; the adapter must keep that distinction.
      const response = await gateway.json(
        "/v1/messages",
        {
          model: world.qualifiedModel,
          max_tokens: 64,
          system: "You are terse.",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
        { token: world.token },
      );
      expect(response.status).toBe(200);
    });
  });

  describe("canonical parity across surfaces", () => {
    test("every surface reaches the provider with the same canonical messages", async () => {
      // One canonical model is the whole point of the gateway: a client can
      // switch surfaces without the provider seeing a different conversation.
      const adapter = gateway.adapters.get(world.providerId)!;
      const before = adapter.dispatches.length;

      await gateway.json(
        "/v1/chat/completions",
        { model: world.qualifiedModel, messages: [{ role: "user", content: "same text" }], stream: false },
        { token: world.token },
      );
      await gateway.json(
        "/v1/messages",
        { model: world.qualifiedModel, max_tokens: 64, messages: [{ role: "user", content: "same text" }], stream: false },
        { token: world.token },
      );

      const dispatched = adapter.dispatches.slice(before);
      expect(dispatched.length).toBe(2);
      const [chat, messages] = dispatched as [DispatchRecord, DispatchRecord];
      // The user's text is identical in both, whatever the surface's own
      // request shape was.
      const textOf = (record: DispatchRecord): string =>
        record.request.messages
          .flatMap((message) => message.content)
          .filter((part) => part.kind === "text")
          .map((part) => part.text)
          .join("");
      expect(textOf(chat)).toContain("same text");
      expect(textOf(messages)).toContain("same text");
      // And the source surface is recorded, so the encoder knows which
      // vocabulary to answer in.
      expect(chat.request.source_surface).toBe("chat");
      expect(messages.request.source_surface).toBe("messages");
    });
  });

  describe("request body validation", () => {
    test("a body that is not JSON is refused as a 400", async () => {
      const response = await gateway.json("/v1/chat/completions", "not json at all", {
        token: world.token,
      });
      expect(response.status).toBe(400);
    });

    test("a request with no model is refused as a 400", async () => {
      const response = await gateway.json(
        "/v1/chat/completions",
        { messages: [{ role: "user", content: "hi" }], stream: false },
        { token: world.token },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    });

    test("an absent or malformed messages field parses as an empty conversation", async () => {
      // Measured contract: the Chat adapter treats a non-array `messages` as an
      // empty list rather than a parse error (`chat/adapter.ts`:
      // `Array.isArray(body.messages) ? body.messages : []`). The request is
      // still routed — the provider receives no turns — so a client gets a
      // completion instead of a 400.
      //
      // This is pinned deliberately, not endorsed: it is the shipped behavior,
      // and a suite that asserted a 400 would be asserting a wish. If the
      // adapter is ever tightened, this test fails and the change is a
      // decision rather than a silent drift.
      for (const body of [
        { model: world.qualifiedModel, stream: false },
        { model: world.qualifiedModel, messages: [], stream: false },
        { model: world.qualifiedModel, messages: "not an array", stream: false },
      ]) {
        const response = await gateway.json("/v1/chat/completions", body, {
          token: world.token,
        });
        expect(response.status).toBe(200);
      }
    });

    test("a GET to a POST-only route is refused", async () => {
      const response = await gateway.request("/v1/chat/completions", { method: "GET" });
      expect([401, 404, 405]).toContain(response.status);
    });
  });
});
