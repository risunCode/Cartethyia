import { describe, expect, test } from "bun:test";
import { protocolError } from "../../src/application/protocols";
import { RequestCodecRegistry } from "../../src/open-sse/translate";
import type { RequestCodec, RequestEncoder, RequestNormalizer } from "../../src/open-sse/translate";

const normalizer = (source: "openai-chat" | "openai-responses"): RequestNormalizer => ({
  source,
  normalize: () => ({ ok: false, error: protocolError("request", "fixture normalizer") }),
});

const encoder = (target: "openai-chat" | "anthropic-messages"): RequestEncoder => ({
  target,
  encode: () => ({ target }),
});

const directCodec: RequestCodec = {
  source: "openai-responses",
  target: "openai-chat",
  normalize: () => ({ ok: false, error: protocolError("request", "fixture codec") }),
  encode: () => ({ target: "openai-chat" }),
};

describe("request codec registry", () => {
  test("prefers a direct codec over canonical fallback", () => {
    const registry = new RequestCodecRegistry();
    registry.registerCodec(directCodec);
    registry.registerNormalizer(normalizer("openai-responses"));
    registry.registerEncoder(encoder("openai-chat"));

    const route = registry.resolve("openai-responses", "openai-chat");

    expect(route?.kind).toBe("direct");
    if (route?.kind === "direct") expect(route.codec).toBe(directCodec);
  });

  test("resolves canonical fallback when direct route is absent", () => {
    const registry = new RequestCodecRegistry();
    const source = normalizer("openai-chat");
    const target = encoder("anthropic-messages");
    registry.registerNormalizer(source);
    registry.registerEncoder(target);

    const route = registry.resolve("openai-chat", "anthropic-messages");

    expect(route).toEqual({ kind: "canonical", normalizer: source, encoder: target });
  });

  test("rejects duplicate codec, normalizer, and encoder registrations", () => {
    const registry = new RequestCodecRegistry();
    registry.registerCodec(directCodec);
    registry.registerNormalizer(normalizer("openai-chat"));
    registry.registerEncoder(encoder("anthropic-messages"));

    expect(() => registry.registerCodec(directCodec)).toThrow("request codec already registered");
    expect(() => registry.registerNormalizer(normalizer("openai-chat"))).toThrow("request normalizer already registered");
    expect(() => registry.registerEncoder(encoder("anthropic-messages"))).toThrow("request encoder already registered");
  });

  test("returns null when no safe direct or canonical route exists", () => {
    const registry = new RequestCodecRegistry();

    expect(registry.resolve("codex", "anthropic-messages")).toBeNull();
  });
});
