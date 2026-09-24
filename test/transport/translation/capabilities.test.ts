import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import { GatewayError } from "../../../src/transport/gateway-error";
import type { RouteCapabilities } from "../../../src/transport/translation/capabilities";
import {
  deriveRequiredCapabilities,
  normalizeGenerationControls,
  projectForRoute,
  routeCapabilitiesFor,
} from "../../../src/transport/translation/capabilities";

describe("projection.test.ts", () => {
  const unrestricted: RouteCapabilities = {
    text: true,
    image: true,
    document: true,
    audio: true,
    webSearch: true,
    tools: true,
    parallelToolCalls: true,
    reasoning: true,
    reasoningEncryptedContent: true,
    responseJsonObject: true,
    responseJsonSchema: true,
    promptCaching: true,
    generationControls: new Set([
      "temperature",
      "top_p",
      "top_k",
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
      "parallel_tool_calls",
      "seed",
      "service_tier",
      "logprobs",
      "top_logprobs",
    ]),
    extensions: new Set(["example"]),
  };

  const request: CanonicalRequest = {
    model: "example-model",
    messages: [
      {
        role: "user",
        content: [
          { kind: "text", text: "inspect this" },
          { kind: "image", payload: { url: "https://example.test/image.png" } },
        ],
      },
    ],
    tools: [{ name: "lookup", jsonSchema: { type: "object" } }],
    generation_controls: { parallel_tool_calls: true, seed: 7 },
    reasoning: { effort: "high" },
    response_format: { type: "json_schema", schema: { type: "object" } },
    cache_hint: "stable_prefix",
    stream: true,
    source_surface: "chat",
  };

  describe("capability-aware projection", () => {
    test("derives every semantic feature before a route lease", () => {
      expect(deriveRequiredCapabilities(request)).toEqual([
        "image",
        "tools",
        "parallel_tool_calls",
        "reasoning",
        "response_format.json_schema",
        "prompt_caching",
        "generation_control:parallel_tool_calls",
        "generation_control:seed",
      ]);
    });

    test("does not derive wire-passthrough extensions as route capabilities", () => {
      const withExtensions: CanonicalRequest = {
        ...request,
        generation_controls: {
          ...request.generation_controls,
          "extension:include_usage": true,
          "extension:user": "user-1",
        },
      };
      const required = deriveRequiredCapabilities(withExtensions);
      expect(required).not.toContain("extension:include_usage");
      expect(required).not.toContain("extension:user");
      expect(required).toContain("generation_control:seed");
    });

    test("declares content-part extension support per wire family", () => {
      const messages = routeCapabilitiesFor({ capability_profile: {}, wire_family: "messages" });
      expect(messages.extensions.has("server_tool_use")).toBe(true);
      expect(messages.extensions.has("search_result")).toBe(true);
      const chat = routeCapabilitiesFor({ capability_profile: {}, wire_family: "chat" });
      expect(chat.extensions.has("server_tool_use")).toBe(false);
      expect(chat.extensions.has("search_result")).toBe(false);
    });

    test("derives document and audio modality requirements from content parts", () => {
      const multimodal: CanonicalRequest = {
        ...request,
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "summarize" },
              { kind: "document", data: "pdf", media_type: "application/pdf" },
              { kind: "audio", data: "bytes", media_type: "audio/mpeg" },
            ],
          },
        ],
      };
      const required = deriveRequiredCapabilities(multimodal);
      expect(required).toContain("document");
      expect(required).toContain("audio");
      expect(required).not.toContain("image");
    });

    test("does not treat a hosted web-search tool as a hard capability", () => {
      const withSearch: CanonicalRequest = {
        ...request,
        messages: [{ role: "user", content: [{ kind: "text", text: "find" }] }],
        tools: [{ name: "web_search", tool_type: "web_search", jsonSchema: { type: "object" } }],
      };
      const required = deriveRequiredCapabilities(withSearch);
      expect(required).toContain("tools");
      expect(required).not.toContain("web_search");
    });

    test("retains a complete request when route capabilities support it", () => {
      expect(projectForRoute(request, unrestricted).requiredCapabilities).toContain("tools");
    });

    test("rejects unsupported semantics rather than silently removing them", () => {
      const withoutImages: RouteCapabilities = { ...unrestricted, image: false };
      try {
        projectForRoute(request, withoutImages);
        throw new Error("expected typed rejection");
      } catch (caught: unknown) {
        expect(caught).toBeInstanceOf(GatewayError);
        const error = caught as GatewayError;
        expect(error.code).toBe("capability_unsupported");
        expect(error.details["capability"]).toBe("image");
      }
    });

    test("normalizes alternate token limits without changing source controls", () => {
      const source = { max_completion_tokens: 21 };
      expect(normalizeGenerationControls(source)).toEqual({
        max_completion_tokens: 21,
        max_output_tokens: 21,
      });
      expect(source).toEqual({ max_completion_tokens: 21 });
    });
  });

  describe("cache-breakpoint preflight validation", () => {
    test("rejects an over-limit breakpoint list with a typed 400 before dispatch", () => {
      const over = { ...request, cache_hint: { kind: "breakpoint" as const, list: [1, 2, 3, 4, 5] } };
      try {
        projectForRoute(over, unrestricted);
        throw new Error("expected typed rejection");
      } catch (caught: unknown) {
        expect(caught).toBeInstanceOf(GatewayError);
        expect((caught as GatewayError).code).toBe("invalid_request");
        expect((caught as GatewayError).status).toBe(400);
      }
    });

    test("accepts exactly the maximum of 4 breakpoints", () => {
      const atLimit = { ...request, cache_hint: { kind: "breakpoint" as const, list: [1, 2, 3, 4] } };
      expect(() => projectForRoute(atLimit, unrestricted)).not.toThrow();
    });
  });
});

