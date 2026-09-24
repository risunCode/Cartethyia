import { describe, expect, test } from "bun:test";
import { classifyCustomAssetFile, MAX_CUSTOM_ASSET_BYTES } from "./customization";

describe("customization asset classification", () => {
  test("classifies image and video mime types", () => {
    expect(classifyCustomAssetFile({ name: "bg.png", type: "image/png" })).toBe("image");
    expect(classifyCustomAssetFile({ name: "bg.webm", type: "video/webm" })).toBe("video");
  });

  test("falls back to extension when mime type is empty", () => {
    expect(classifyCustomAssetFile({ name: "clip.mp4", type: "" })).toBe("video");
    expect(classifyCustomAssetFile({ name: "clip.mov", type: "" })).toBe("video");
    expect(classifyCustomAssetFile({ name: "pic.jpg", type: "" })).toBeNull();
  });

  test("rejects unsupported documents", () => {
    expect(classifyCustomAssetFile({ name: "notes.txt", type: "text/plain" })).toBeNull();
    expect(classifyCustomAssetFile({ name: "data.json", type: "application/json" })).toBeNull();
  });
});

describe("customization storage limits", () => {
  test("hard cap is 200MB", () => {
    expect(MAX_CUSTOM_ASSET_BYTES).toBe(200 * 1024 * 1024);
  });
});
