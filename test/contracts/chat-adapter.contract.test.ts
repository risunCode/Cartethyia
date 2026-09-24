import { describe, expect, test } from "bun:test";

import { ChatAdapter } from "../../src/transport/surface/chat/adapter";
import { ContractHarness } from "./contract-harness";

interface LiveApp {
  handle(request: Request): Response | Promise<Response>;
}

function asLiveApp(value: unknown): LiveApp {
  if (
    value === null ||
    typeof value !== "object" ||
    !("handle" in value) ||
    typeof value.handle !== "function"
  ) {
    throw new Error("production composition root did not expose a live request handler");
  }
  return value as LiveApp;
}

async function postChat(
  harness: ContractHarness,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const app = asLiveApp(await harness.buildProductionCompositionRoot());
  return app.handle(
    new Request("http://cartethyia.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cartethyia-surface": "chat",
        authorization: "Bearer test-contract-key",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function sseObjects(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: {") && line.endsWith("}"))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("Chat adapter production composition", () => {
  test("routes a minimal Chat request through the live /v1 app", async () => {
    const harness = new ContractHarness();
    const response = await postChat(harness, harness.requests.openAiChat());
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body).toMatchObject({ object: "chat.completion", model: "cartethyia-test-model" });
    expect(body.choices).toBeArray();
    expect(body).not.toHaveProperty("output");
  });

  test("keeps non-streaming output on the Chat completion contract", async () => {
    const harness = new ContractHarness();
    const response = await postChat(harness, harness.requests.openAiChat({ stream: false }));
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await responseJson(response);
    expect(body.object).toBe("chat.completion");
    expect(body.usage).not.toBeUndefined();
    expect(body).not.toHaveProperty("output");
  });

  test("keeps streaming Chat chunks, stable identity, and requested usage", async () => {
    const harness = new ContractHarness();
    const response = await postChat(
      harness,
      harness.requests.openAiChat({
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const chunks = sseObjects(await response.text());
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(chunks.map((chunk) => chunk.id))).toHaveLength(1);
    expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);

    const usageOnlyChunks = chunks.filter((chunk) => {
      return Array.isArray(chunk.choices) && chunk.choices.length === 0;
    });
    expect(usageOnlyChunks).toHaveLength(1);
    const terminalChoices = chunks.at(-2)?.choices;
    expect(Array.isArray(terminalChoices) ? terminalChoices[0] : undefined).toMatchObject({
      finish_reason: "stop",
    });
    expect(chunks.at(-1)?.choices).toEqual([]);
    expect(chunks.at(-1)?.usage).not.toBeNull();
  });
  test("round-trips assistant tool calls and client tool results without changing Chat surface", async () => {
    const harness = new ContractHarness();
    const first = await postChat(
      harness,
      harness.requests.openAiChat({
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a key",
              parameters: { type: "object", properties: { key: { type: "string" } } },
            },
          },
        ],
        tool_choice: "required",
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = await responseJson(first);
    expect(firstBody.object).toBe("chat.completion");
    const firstChoice = (firstBody.choices as Array<Record<string, unknown>>)[0];
    const firstMessage = firstChoice?.message as Record<string, unknown> | undefined;
    const toolCalls = firstMessage?.tool_calls as Array<Record<string, unknown>> | undefined;
    expect(toolCalls).toBeArray();
    expect(toolCalls?.[0]).toMatchObject({ type: "function" });

    const secondMessages = [
      { role: "user", content: "Find a key" },
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "tool", tool_call_id: String(toolCalls?.[0]?.id ?? "call-1"), content: "found" },
    ];
    const second = await postChat(
      harness,
      harness.requests.openAiChat({ messages: secondMessages }),
    );
    expect(second.status).toBe(200);
    const secondBody = await responseJson(second);
    expect(secondBody.object).toBe("chat.completion");
    expect(secondBody).not.toHaveProperty("response");

    const parsed = new ChatAdapter().parse({
      model: "cartethyia-test-model",
      messages: secondMessages,
    });
    expect(parsed.source_surface).toBe("chat");
    expect(parsed.messages.at(-1)).toMatchObject({
      role: "tool",
      content: [{ kind: "toolResult", content: "found" }],
    });
  });
});
