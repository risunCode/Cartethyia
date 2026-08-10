import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CustomAtmosphere,
  classifyCustomAssetFile,
  saveCustomizationSettings,
} from "../../../src/features/customization/background";

const baseSettings = {
  backgroundAsset: null,
  backgroundEnabled: true,
  backgroundOpacity: 21,
  backgroundBlur: 2,
  solidMode: false,
};

function saveAsset(kind: "image" | "video", name: string, content: string): void {
  saveCustomizationSettings({
    ...baseSettings,
    backgroundAsset: { kind, name, blob: new Blob([content], { type: kind === "video" ? "video/webm" : "image/webp" }) },
  });
}

describe("customization media classification and rendering", () => {
  const createObjectUrl = vi.fn((blob: Blob) => `blob:background-${blob.size}`);
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("URL", { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
  });

  afterEach(() => {
    saveCustomizationSettings(baseSettings);
    vi.unstubAllGlobals();
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
  });

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

  test("renders a newly selected image override instead of the previous asset", async () => {
    saveAsset("image", "first.webp", "first");
    const { rerender } = render(createElement(CustomAtmosphere));
    await waitFor(() => expect(document.querySelector(".custom-background-layer")).toHaveAttribute("src", "blob:background-5"));

    saveAsset("image", "second.webp", "second");
    rerender(createElement(CustomAtmosphere));
    await waitFor(() => expect(document.querySelector(".custom-background-layer")).toHaveAttribute("src", "blob:background-6"));
    expect(revokeObjectUrl).toHaveBeenCalled();
  });

  test("renders video overrides as autoplaying muted background media", async () => {
    saveAsset("video", "clip.webm", "video");
    render(createElement(CustomAtmosphere));
    await waitFor(() => expect(document.querySelector("video.custom-background-layer")).toHaveAttribute("src", "blob:background-5"));

    const video = document.querySelector<HTMLVideoElement>("video.custom-background-layer");
    expect(video).not.toBeNull();
    if (!video) return;
    expect(video.autoplay).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.playsInline).toBe(true);
  });
});
