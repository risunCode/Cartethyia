import { describe, expect, test } from "vitest";
import { classifyCustomAssetFile } from "../../../src/features/customization/background";

describe("customization media classification", () => {
  test("accepts MP4 files with the browser video MIME type", () => {
    expect(classifyCustomAssetFile({ name: "hero.mp4", type: "video/mp4" })).toBe("video");
  });

  test("accepts MP4 files when the browser leaves MIME type empty", () => {
    expect(classifyCustomAssetFile({ name: "hero.MP4", type: "" })).toBe("video");
  });

  test("keeps image uploads separate from supported video uploads", () => {
    expect(classifyCustomAssetFile({ name: "poster.png", type: "image/png" })).toBe("image");
    expect(classifyCustomAssetFile({ name: "clip.webm", type: "video/webm" })).toBe("video");
  });

  test("rejects unsupported files", () => {
    expect(classifyCustomAssetFile({ name: "notes.txt", type: "text/plain" })).toBeNull();
    expect(classifyCustomAssetFile({ name: "archive.mkv", type: "application/octet-stream" })).toBeNull();
  });
});
