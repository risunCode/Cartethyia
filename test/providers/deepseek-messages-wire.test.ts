/**
 * DeepSeek dispatches on its Anthropic-compatible Messages wire, not the OpenAI
 * chat wire it also serves.
 *
 * `https://api.deepseek.com/anthropic` + `/v1/messages` is the documented
 * endpoint; the `/v1/models` OpenAI-compatible surface still answers discovery
 * on the provider's bare host. These cases pin the wire, the composed URL, and
 * the fact that the model rows do not fall back to the `/messages` default that
 * would compose to `/anthropic/messages`.
 */
import { describe, expect, test } from "bun:test";
import { createDeepseekAnthropicAdapter } from "../../src/providers/adapters/anthropic";
import { endpointUrl } from "../../src/protocol/codecs";
import { PROVIDER_CAPABILITIES } from "../../src/providers/default-registry";
import { DEEPSEEK_MODELS } from "../../src/providers/specs/deepseek";
import { GENERIC_API_KEY_SPECS, GENERIC_API_KEY_PROVIDER_IDS } from "../../src/providers/specs/configured-openai-providers";
import { providerBaseUrl, providerDefaultWireFamily } from "../../src/providers/metadata";

describe("deepseek anthropic messages wire", () => {
  test("every catalog row declares the messages wire and the versioned path", () => {
    for (const model of DEEPSEEK_MODELS) {
      expect(model.wireFamily).toBe("messages");
      // Not the `/messages` wire default: the base already ends at `/anthropic`.
      expect(model.endpointPath).toBe("/v1/messages");
      expect(endpointUrl("https://api.deepseek.com/anthropic", model.endpointPath)).toBe(
        "https://api.deepseek.com/anthropic/v1/messages",
      );
    }
  });

  test("the provider default wire is messages and the base stays the OpenAI host", () => {
    expect(providerDefaultWireFamily("deepseek")).toBe("messages");
    // Discovery reads `/v1/models` from the bare host, not the `/anthropic` root.
    expect(providerBaseUrl("deepseek")).toBe("https://api.deepseek.com");
  });

  test("the registry registers the messages endpoint path and the anthropic adapter", async () => {
    const module = PROVIDER_CAPABILITIES.deepseek;
    expect(module.endpointPathsByWireFamily).toEqual({ messages: "/v1/messages" });

    const adapter = await module.loadAdapter();
    // `assertAdapterIdentity` in the registry would reject a mismatch at load.
    expect(adapter.provider_id).toBe("deepseek");
  });

  test("the deepseek adapter reports its own id and composes the documented URL", () => {
    // The registry's identity check compares this id against the registration,
    // so the factory must not hand back the `"anthropic"` default.
    const adapter = createDeepseekAnthropicAdapter();
    expect(adapter.provider_id).toBe("deepseek");

    // The adapter joins its own base (the `/anthropic` root) with the candidate's
    // endpoint path; this is the URL the wire actually posts to.
    expect(endpointUrl(`${providerBaseUrl("deepseek")}/anthropic`, "/v1/messages")).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
  });

  test("deepseek is no longer a generic openai-compatible provider", () => {
    expect(GENERIC_API_KEY_PROVIDER_IDS).not.toContain("deepseek");
    expect(Object.keys(GENERIC_API_KEY_SPECS)).not.toContain("deepseek");
  });
});
