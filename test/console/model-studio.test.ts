import { describe, expect, test } from "bun:test";
import {
  createStudioSession,
  deleteStudioSession,
  getStudioSession,
  normalizeStudioMedia,
  patchStudioSession,
} from "../../src/console/model-studio";

describe("Model Studio media persistence", () => {
  test("rejects malformed media entries", () => {
    expect(normalizeStudioMedia([{ id: "missing-fields" }])).toBeNull();
  });

  test("bounds persisted media gallery results and URLs", () => {
    const longUrl = `data:image/png;base64,${"a".repeat(512_001)}`;
    const results = normalizeStudioMedia([
      {
        id: "image-1",
        type: "image",
        model: "codex/gpt-5.5-image",
        prompt: "a red apple",
        urls: [longUrl, "https://example.test/1.png", "https://example.test/2.png", "https://example.test/3.png", "https://example.test/4.png", "https://example.test/5.png"],
        aspectRatio: "1:1",
        count: 4,
        createdAt: new Date().toISOString(),
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results?.[0]?.urls).toEqual([
      "https://example.test/2.png",
      "https://example.test/3.png",
      "https://example.test/4.png",
      "https://example.test/5.png",
    ]);
  });

  test("stores media results with the bounded session", () => {
    const session = createStudioSession({ title: "Media test" });
    const media = normalizeStudioMedia([{
      id: "image-1",
      type: "image",
      model: "antigravity/gemini-3.1-flash-image",
      prompt: "a quiet garden",
      urls: ["data:image/png;base64,AAAA"],
      aspectRatio: "1:1",
      count: 1,
      createdAt: new Date().toISOString(),
    }]);
    if (media === null) throw new Error("media fixture should be valid");

    const updated = patchStudioSession(session.id, { media: media ?? [] });
    expect(updated?.media).toEqual(media);
    expect(getStudioSession(session.id)?.media).toEqual(media);
    expect(deleteStudioSession(session.id)).toBe(true);
  });
});
