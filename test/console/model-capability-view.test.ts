import { describe, expect, test } from "bun:test";
import { capabilitiesOf, modelOf } from "../../src/open-sse/transport/catalog";
import { modelCapabilityView, modelCapabilityViewFromCapabilities } from "../../src/console/views/models";

describe("Providers catalog capability view", () => {
  test("does not classify vision input support as media generation", () => {
    const model = modelOf(
      "vision-chat",
      "Vision Chat",
      capabilitiesOf({ surfaces: ["openai-responses"], images: true }),
    );

    expect(modelCapabilityView(model)).toEqual({ chat: true, media: false, imageGeneration: false, videoGeneration: false, websearch: false });
  });

  test("classifies image generation surfaces as media", () => {
    const model = modelOf(
      "image-generator",
      "Image Generator",
      capabilitiesOf({ surfaces: ["images"], images: true }),
    );

    expect(modelCapabilityView(model)).toEqual({ chat: false, media: true, imageGeneration: true, videoGeneration: false, websearch: false });
  });

  test("classifies explicit video generation independently from vision input", () => {
    const model = modelOf(
      "video-generator",
      "Video Generator",
      capabilitiesOf({ surfaces: ["openai-chat"], mediaGeneration: ["video"] }),
    );

    expect(modelCapabilityView(model)).toEqual({ chat: true, media: true, imageGeneration: false, videoGeneration: true, websearch: false });
  });

  test("preserves chat and additional generation capabilities from provider fallbacks", () => {
    const capabilities = capabilitiesOf({ surfaces: ["openai-chat", "images"], images: true });

    expect(modelCapabilityViewFromCapabilities(capabilities)).toEqual({ chat: true, media: true, imageGeneration: true, videoGeneration: false, websearch: false });
  });
});
