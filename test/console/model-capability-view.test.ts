import { describe, expect, test } from "bun:test";
import { capabilitiesOf, modelOf } from "../../src/open-sse/transport/catalog";
import { modelCapabilityView } from "../../src/console/views/models";

describe("Providers catalog capability view", () => {
  test("does not classify vision input support as media generation", () => {
    const model = modelOf(
      "vision-chat",
      "Vision Chat",
      capabilitiesOf({ surfaces: ["openai-responses"], images: true }),
    );

    expect(modelCapabilityView(model)).toEqual({ chat: true, media: false, websearch: false });
  });

  test("classifies image generation surfaces as media", () => {
    const model = modelOf(
      "image-generator",
      "Image Generator",
      capabilitiesOf({ surfaces: ["images"], images: true }),
    );

    expect(modelCapabilityView(model)).toEqual({ chat: false, media: true, websearch: false });
  });
});
