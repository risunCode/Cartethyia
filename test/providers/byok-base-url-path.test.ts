/**
 * A BYOK Base URL is a **root**, not a full endpoint. Operators routinely paste
 * the endpoint they found in their provider's docs
 * (`https://api.deepseek.com/anthropic/v1/messages`), and the model list was
 * then derived from that path — producing `…/anthropic/models`, a 404 that
 * looked like a credential or egress problem.
 *
 * These cases pin the two halves of the fix: `modelListUrl` lands on the real
 * index, and `splitEndpointBaseUrl` names the origin an operator should save
 * (not the leftover `/anthropic`, which still 404s).
 */
import { describe, expect, test } from "bun:test";
import {
  modelDiscoveryBaseUrl,
  modelListUrl,
  resolveByokWireProfile,
  splitEndpointBaseUrl,
} from "../../src/providers/operations/byok-wire-profile";

describe("BYOK base URL path confusion", () => {
  test("a pasted endpoint still discovers the real model list", () => {
    // The exact input from documentation/fix-byok-base-url-path.md.
    expect(modelListUrl("https://api.deepseek.com/anthropic/v1/messages")).toBe(
      "https://api.deepseek.com/v1/models",
    );
    expect(modelListUrl("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(modelListUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });

  test("a root, and a root that already carries a version, are untouched", () => {
    expect(modelListUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/models");
    expect(modelListUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/models");
    expect(modelListUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/models");
    // A gateway prefix is a real root, not an endpoint: its list lives there.
    expect(modelListUrl("https://gateway.example/custom/prefix")).toBe(
      "https://gateway.example/custom/prefix/models",
    );
  });

  test("the suggested correction is the origin, not the leftover path", () => {
    expect(splitEndpointBaseUrl("https://api.deepseek.com/anthropic/v1/messages")).toEqual({
      baseUrl: "https://api.deepseek.com",
      stripped: "/anthropic/v1/messages",
    });
    expect(splitEndpointBaseUrl("https://api.openai.com/v1/chat/completions")).toEqual({
      baseUrl: "https://api.openai.com",
      stripped: "/v1/chat/completions",
    });
    // A base that is already a root reports nothing stripped.
    for (const root of [
      "https://api.deepseek.com",
      "https://api.deepseek.com/v1",
      "https://gateway.example/custom/prefix",
    ]) {
      expect(splitEndpointBaseUrl(root)).toEqual({ baseUrl: root, stripped: "" });
    }
  });

  test("a pasted URL without a scheme still yields a usable base", () => {
    // The console has already validated the shape by the time this runs; a
    // string the URL parser rejects must not throw here.
    expect(modelDiscoveryBaseUrl("not a url")).toBe("not a url/v1");
    expect(splitEndpointBaseUrl("not a url")).toEqual({ baseUrl: "not a url", stripped: "" });
  });

  test("the wire profile is unchanged: a Messages-only root still reads x-api-key", () => {
    // The endpoint fix is about URL derivation, not auth. A base URL that ends
    // at an endpoint must not flip which header the profile derives.
    const messages = resolveByokWireProfile("messages", null);
    expect(messages.authHeaderShape).toBe("x_api_key");
    expect(messages.supportedWireFamilies).toEqual(["messages"]);

    const chat = resolveByokWireProfile("chat", null);
    expect(chat.authHeaderShape).toBe("authorization_bearer");
    expect(chat.supportedWireFamilies).toEqual(["chat", "responses"]);
  });
});
