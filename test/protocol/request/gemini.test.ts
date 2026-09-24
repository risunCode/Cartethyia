import { describe, expect, test } from "bun:test";
import { buildGeminiPayload } from "../../../src/protocol/request/gemini";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

function requestWithTools(tools: CanonicalRequest["tools"]): CanonicalRequest {
  return {
    model: "gemini-2.0-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    tools,
  } as CanonicalRequest;
}

function declarationsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const tools = payload["tools"] as Array<Record<string, unknown>>;
  return (tools[0]?.["functionDeclarations"] ?? []) as Array<Record<string, unknown>>;
}

describe("buildGeminiPayload schema sanitization", () => {
  test("maps const to single-value enum and flattens oneOf", () => {
    const payload = buildGeminiPayload(
      requestWithTools([
        {
          name: "lookup",
          jsonSchema: {
            type: "object",
            properties: {
              mode: { const: "fast" },
              target: { oneOf: [{ type: "string" }, { type: "number" }] },
            },
            required: ["mode", "target", "ghost"],
          },
        },
      ]),
    );
    const [declaration] = declarationsOf(payload);
    const parameters = declaration?.["parameters"] as Record<string, unknown>;
    const properties = parameters["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["mode"]).toEqual({ enum: ["fast"] });
    expect(properties["target"]).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    // Unknown required names are pruned so Gemini never 400s on them.
    expect(parameters["required"]).toEqual(["mode", "target"]);
  });

  test("gives typeless arrays an items schema", () => {
    const payload = buildGeminiPayload(
      requestWithTools([
        {
          name: "list",
          jsonSchema: { type: "object", properties: { tags: { type: "array" } } },
        },
      ]),
    );
    const [declaration] = declarationsOf(payload);
    const properties = (declaration?.["parameters"] as Record<string, unknown>)["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties["tags"]).toEqual({ type: "array", items: {} });
  });

  test("floors maxOutputTokens from the thinking budget", () => {
    const base: CanonicalRequest = {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: { max_tokens: 1024 },
      stream: false,
      source_surface: "chat",
      reasoning: { thinking_type: "enabled", budget_tokens: 5000 },
    } as CanonicalRequest;
    const payload = buildGeminiPayload(base);
    const generationConfig = payload["generationConfig"] as Record<string, unknown>;
    expect(generationConfig["thinkingConfig"]).toEqual({ thinkingBudget: 5000 });
    // Budget 5000 lands in the 1025..8192 tier: floor 16384 wins over 1024.
    expect(generationConfig["maxOutputTokens"]).toBe(16384);
  });

  test("floors maxOutputTokens from the effort level", () => {
    const base: CanonicalRequest = {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
      reasoning: { thinking_type: "enabled", effort: "high" },
    } as CanonicalRequest;
    const payload = buildGeminiPayload(base);
    const generationConfig = payload["generationConfig"] as Record<string, unknown>;
    expect(generationConfig["maxOutputTokens"]).toBe(65535);
  });

  test("leaves explicit wide ceilings and disabled thinking alone", () => {
    const wide = buildGeminiPayload({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: { max_tokens: 100_000 },
      stream: false,
      source_surface: "chat",
      reasoning: { thinking_type: "enabled", budget_tokens: 5000 },
    } as CanonicalRequest);
    expect((wide["generationConfig"] as Record<string, unknown>)["maxOutputTokens"]).toBe(100_000);

    const disabled = buildGeminiPayload({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: { max_tokens: 1024 },
      stream: false,
      source_surface: "chat",
      reasoning: { thinking_type: "disabled", budget_tokens: 5000 },
    } as CanonicalRequest);
    expect((disabled["generationConfig"] as Record<string, unknown>)["maxOutputTokens"]).toBe(1024);
  });
});
