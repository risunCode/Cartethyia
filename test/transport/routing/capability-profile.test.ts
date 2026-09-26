import { describe, expect, test } from "bun:test";

import { buildCapabilityProfile } from "../../../src/transport/routing/route-catalog";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import {
  candidateSupportsRequest,
  deriveRequiredCapabilities,
  projectForRoute,
  routeCapabilitiesFor,
} from "../../../src/transport/translation/capabilities";

/** A codec-backed route (any provider whose adapter uses a canonical codec). */
function profile(
  providerId = "openai",
  modalities: { input?: readonly string[]; output?: readonly string[] } | null = null,
) {
  return buildCapabilityProfile({
    modalities,
    reasoning: false,
    toolCall: true,
    webSearch: false,
    providerId,
  });
}

describe("buildCapabilityProfile", () => {
  test("keeps rich content parts on the codec wires regardless of declared modalities", () => {
    // A metadata gap must not become a silent rewrite: the canonical codecs all
    // encode image/document/audio parts, so a codec-backed route carries them
    // and the upstream decides whether it accepts them. Whether the *model*
    // accepts the part is not something the router can settle by guessing from
    // a catalog row.
    const bare = profile("openai");
    expect(bare.image).toBe(true);
    expect(bare.document).toBe(true);
    expect(bare.audio).toBe(true);
  });

  test("gates rich content on a bespoke adapter", () => {
    // Cursor/Devin frame their own protocol, so they have no generic
    // rich-content path: only an explicit modality grants the capability.
    const bespoke = profile("cursor");
    expect(bespoke.image).toBe(false);
    expect(bespoke.document).toBe(false);
    expect(bespoke.audio).toBe(false);
    expect(profile("cursor", { input: ["text", "image"] }).image).toBe(true);
    // Devin is the other bundled bespoke adapter.
    expect(profile("devin").image).toBe(false);
  });

  test("denies audio on the messages wire, whatever the catalog declares", () => {
    // The profile grants audio to every codec-backed route, but the wire
    // vocabulary is the deciding fact: the Anthropic Messages request has no
    // audio content block, and every provider on that wire (Anthropic, Claude
    // Code, Kimi) speaks that schema. Without the narrowing, such a route
    // claims audio it cannot encode, passes the pre-lease gate, and reaches the
    // builder to emit a block the provider rejects — failing the whole request.
    for (const provider of ["anthropic", "claude", "kimi"]) {
      expect(profile(provider).audio).toBe(true); // profile-level codec grant
      const route = routeCapabilitiesFor({
        capability_profile: profile(provider),
        wire_family: "messages",
      });
      expect(route.audio).toBe(false); // narrowed at projection time
    }
    // A catalog's audio flag describes the model, not the wire: it cannot add a
    // block the schema does not define.
    const declared = buildCapabilityProfile({
      modalities: { input: ["text", "audio"] },
      reasoning: false,
      toolCall: true,
      webSearch: false,
      providerId: "kimi",
    });
    expect(routeCapabilitiesFor({ capability_profile: declared, wire_family: "messages" }).audio).toBe(
      false,
    );
    // The wires that do define an audio block keep it.
    expect(routeCapabilitiesFor({ capability_profile: profile("openai"), wire_family: "chat" }).audio).toBe(
      true,
    );
    expect(
      routeCapabilitiesFor({ capability_profile: profile("codex"), wire_family: "responses" }).audio,
    ).toBe(true);
    // A bespoke adapter is decided by its own declaration, since no wire codec
    // re-encodes it.
    expect(routeCapabilitiesFor({ capability_profile: profile("cursor"), wire_family: "chat" }).audio).toBe(
      false,
    );
    expect(
      routeCapabilitiesFor({
        capability_profile: profile("cursor", { input: ["text", "audio"] }),
        wire_family: "chat",
      }).audio,
    ).toBe(true);
  });

  test("an audio request no longer routes to a messages-only model", () => {
    // The end-to-end consequence: `candidateSupportsRequest` is the single
    // predicate the router and planner share, so a false here is what keeps the
    // request off an incapable route instead of letting it fail upstream.
    const audioRequest: CanonicalRequest = {
      model: "m",
      messages: [{ role: "user", content: [{ kind: "audio", data: "QUJD", media_type: "audio/wav" }] }],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
    };
    const required = deriveRequiredCapabilities(audioRequest);
    expect(required).toContain("audio");
    expect(
      candidateSupportsRequest(
        { capability_profile: profile("kimi"), wire_family: "messages" },
        required,
      ),
    ).toBe(false);
    expect(
      candidateSupportsRequest(
        { capability_profile: profile("openai"), wire_family: "chat" },
        required,
      ),
    ).toBe(true);
    // Image and document are unaffected: only audio is wire-specific.
    const imageRequest: CanonicalRequest = {
      ...audioRequest,
      messages: [
        {
          role: "user",
          content: [
            { kind: "text", text: "look" },
            { kind: "image", payload: { url: "https://example.test/a.png" } },
          ],
        },
      ],
    };
    expect(
      candidateSupportsRequest(
        { capability_profile: profile("kimi"), wire_family: "messages" },
        deriveRequiredCapabilities(imageRequest),
      ),
    ).toBe(true);
  });

  test("a bespoke adapter receives generation controls unfiltered", () => {
    // No codec re-encodes a bespoke adapter's request, so a wire matrix would
    // drop controls the adapter reads directly. `seed` is absent from the
    // messages matrix and must still reach a bespoke route.
    const bespoke = routeCapabilitiesFor({
      capability_profile: profile("cursor"),
      wire_family: "chat",
    });
    expect(bespoke.generationControls.has("seed")).toBe(true);
    expect(bespoke.generationControls.has("logprobs")).toBe(true);
    // A codec route keeps its own wire's narrower set.
    const codec = routeCapabilitiesFor({
      capability_profile: profile("anthropic"),
      wire_family: "messages",
    });
    expect(codec.generationControls.has("seed")).toBe(false);
  });

  test("never strips reasoning or tools, whatever the row records", () => {
    // A false flag must not become a silent rewrite. The caller asked for
    // reasoning and tools; the upstream answers if it cannot serve them.
    for (const source of ["discovered", "builtin", "manual", undefined]) {
      const row = buildCapabilityProfile({
        modalities: { input: ["text"], output: ["text"] },
        reasoning: false,
        toolCall: false,
        webSearch: true,
        providerId: "openai",
        ...(source === undefined ? {} : { source }),
      });
      expect(row.reasoning).toBe(true);
      expect(row.reasoningEncryptedContent).toBe(true);
      expect(row.tools).toBe(true);
      expect(row.parallelToolCalls).toBe(true);
      expect(row.webSearch).toBe(true);
    }
  });

  test("carries an attached image through the pre-lease gate for a model that declares no modalities", () => {
    // The end-to-end consequence of the fail-open: a model row with no
    // modality metadata reaches `projectForRoute` still able to serve an
    // image-bearing request, so the caller's attachment is not rewritten to
    // `[image]` on the strength of missing metadata.
    const request: CanonicalRequest = {
      model: "unlisted-model",
      messages: [
        {
          role: "user",
          content: [
            { kind: "text", text: "inspect this" },
            { kind: "image", payload: { url: "https://example.test/image.png" } },
          ],
        },
      ],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
    };
    const projected = projectForRoute(
      request,
      routeCapabilitiesFor({
        capability_profile: profile("openai"),
        wire_family: "chat",
      }),
    );
    expect(projected.messages[0]?.content).toContainEqual({
      kind: "image",
      payload: { url: "https://example.test/image.png" },
    });
  });
});
