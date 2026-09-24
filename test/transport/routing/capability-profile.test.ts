import { describe, expect, test } from "bun:test";

import { buildCapabilityProfile } from "../../../src/transport/routing/route-catalog";
import type { CanonicalRequest, WireFamily } from "../../../src/transport/canonical-model";
import {
  projectForRoute,
  routeCapabilitiesFor,
} from "../../../src/transport/translation/capabilities";

function profile(
  wireFamily: WireFamily,
  modalities: { input?: readonly string[]; output?: readonly string[] } | null = null,
) {
  return buildCapabilityProfile({
    modalities,
    reasoning: false,
    toolCall: true,
    webSearch: false,
    wireFamily,
  });
}

describe("buildCapabilityProfile", () => {
  test("keeps rich content parts on the codec wires regardless of declared modalities", () => {
    // A metadata gap must not become a silent rewrite: the canonical codecs all
    // encode image/document/audio parts, so a codec-backed route carries them
    // and the upstream decides whether it accepts them. Whether the *model*
    // accepts the part is not something the router can settle by guessing from
    // a catalog row.
    const bare = profile("chat");
    expect(bare.image).toBe(true);
    expect(bare.document).toBe(true);
    expect(bare.audio).toBe(true);
  });

  test("gates rich content on a bespoke native adapter", () => {
    // Cursor/Devin have no generic rich-content path, so only an explicit
    // modality grants the capability there.
    const native = profile("native");
    expect(native.image).toBe(false);
    expect(native.document).toBe(false);
    expect(native.audio).toBe(false);
    expect(profile("native", { input: ["text", "image"] }).image).toBe(true);
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
        wireFamily: "chat",
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
        capability_profile: profile("chat"),
        wire_family: "chat",
      }),
    );
    expect(projected.messages[0]?.content).toContainEqual({
      kind: "image",
      payload: { url: "https://example.test/image.png" },
    });
  });
});
