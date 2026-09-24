// Regression coverage for the BYOK wire-profile derivation: a custom
// provider's adapter contract (supported families, endpoint paths, and the
// credential header shape) must be derived from its persisted wire-family
// default + compatibility profile, so an Anthropic-compatible provider
// dispatches to `/v1/messages` with `x-api-key` and stays distinct from an
// OpenAI-compatible one.
import { describe, expect, test } from "bun:test";
import {
  byokAuthHeaderShape,
  modelListUrl,
  resolveByokWireProfile,
  stripEndpointBasePath,
} from "../../../src/providers/operations/byok-wire-profile";

describe("resolveByokWireProfile", () => {
  test("a chat default serves chat + responses with bearer auth", () => {
    const profile = resolveByokWireProfile("chat", null);
    expect(profile.supportedWireFamilies).toEqual(["chat", "responses"]);
    expect(profile.authHeaderShape).toBe("authorization_bearer");
    expect(profile.endpointPathsByWireFamily.chat).toBe("/v1/chat/completions");
    expect(profile.endpointPathsByWireFamily.responses).toBe("/v1/responses");
  });

  test("a messages default serves only messages with x-api-key auth", () => {
    const profile = resolveByokWireProfile("messages", null);
    expect(profile.supportedWireFamilies).toEqual(["messages"]);
    expect(profile.authHeaderShape).toBe("x_api_key");
    expect(profile.endpointPathsByWireFamily.messages).toBe("/v1/messages");
  });

  test("operator endpoint declarations win over derived defaults", () => {
    const profile = resolveByokWireProfile("chat", {
      endpoint_paths_by_wire_family: { messages: "/custom/v1/messages" },
    });
    expect(profile.supportedWireFamilies).toEqual(["messages"]);
    expect(profile.authHeaderShape).toBe("x_api_key");
    expect(profile.endpointPathsByWireFamily.messages).toBe("/custom/v1/messages");
  });

  test("an explicit declaration of both OpenAI wires keeps bearer auth", () => {
    const profile = resolveByokWireProfile("messages", {
      endpoint_paths_by_wire_family: {
        chat: "/v1/chat/completions",
        responses: "/v1/responses",
      },
    });
    expect(profile.supportedWireFamilies).toEqual(["chat", "responses"]);
    expect(profile.authHeaderShape).toBe("authorization_bearer");
  });

  test("falls back to chat defaults when the default family column is absent", () => {
    const profile = resolveByokWireProfile(undefined, undefined);
    expect(profile.supportedWireFamilies).toEqual(["chat", "responses"]);
    expect(profile.authHeaderShape).toBe("authorization_bearer");
  });
});

describe("stripEndpointBasePath", () => {
  test("strips a repeated base path from the endpoint", () => {
    expect(stripEndpointBasePath("/v1/chat/completions", "https://api.example.com/v1")).toBe(
      "/chat/completions",
    );
  });

  test("leaves endpoints whose base has no path untouched", () => {
    expect(stripEndpointBasePath("/v1/chat/completions", "https://api.example.com")).toBe(
      "/v1/chat/completions",
    );
  });
});

describe("modelListUrl", () => {
  test("bare root gets the v1 prefix", () => {
    expect(modelListUrl("https://api.example.com")).toBe("https://api.example.com/v1/models");
  });

  test("a base that already carries v1 does not double the segment", () => {
    expect(modelListUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/models",
    );
  });
});

describe("byokAuthHeaderShape", () => {
  test("messages-only upstream reads x-api-key", () => {
    expect(byokAuthHeaderShape(["messages"])).toBe("x_api_key");
  });

  test("any OpenAI wire reads bearer auth", () => {
    expect(byokAuthHeaderShape(["chat"])).toBe("authorization_bearer");
    expect(byokAuthHeaderShape(["chat", "responses"])).toBe("authorization_bearer");
    expect(byokAuthHeaderShape(["messages", "responses"])).toBe("authorization_bearer");
  });
});