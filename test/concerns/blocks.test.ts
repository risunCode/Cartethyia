import { describe, expect, test } from "bun:test";
import { flattenText, isImageBlock, isTextBlock, isToolCallBlock, isToolResultBlock, textBlock, toAnthropicRole } from "../../src/translate/concerns/blocks";
import type { UnifiedBlock } from "../../src/translate/concerns/blocks";

describe("blocks concern", () => {
  test("textBlock defaults cache to false", () => {
    expect(textBlock("hi")).toEqual({ type: "text", text: "hi", cache: false });
  });

  test("textBlock honors explicit cache flag", () => {
    expect(textBlock("hi", true)).toEqual({ type: "text", text: "hi", cache: true });
  });

  test("type guards discriminate each block kind and nothing else", () => {
    const blocks: UnifiedBlock[] = [
      { type: "text", text: "t", cache: false },
      { type: "image", source: { kind: "url", url: "https://x/y.png" }, cache: false },
      { type: "tool_call", id: "1", name: "f", input: {}, cache: false },
      { type: "tool_result", toolCallId: "1", content: "ok", isError: false, cache: false },
    ];
    expect(blocks.filter(isTextBlock)).toHaveLength(1);
    expect(blocks.filter(isImageBlock)).toHaveLength(1);
    expect(blocks.filter(isToolCallBlock)).toHaveLength(1);
    expect(blocks.filter(isToolResultBlock)).toHaveLength(1);
  });

  test("flattenText concatenates only text blocks in order, skipping others", () => {
    const blocks: UnifiedBlock[] = [
      textBlock("Hello, "),
      { type: "image", source: { kind: "url", url: "https://x/y.png" }, cache: false },
      textBlock("world!"),
      { type: "tool_call", id: "1", name: "f", input: {}, cache: false },
    ];
    expect(flattenText(blocks)).toBe("Hello, world!");
  });

  test("flattenText on no text blocks returns empty string", () => {
    const blocks: UnifiedBlock[] = [{ type: "tool_call", id: "1", name: "f", input: {}, cache: false }];
    expect(flattenText(blocks)).toBe("");
  });
});

describe("blocks concern — toAnthropicRole", () => {
  test("assistant maps to assistant", () => {
    expect(toAnthropicRole("assistant")).toBe("assistant");
  });

  test("user maps to user", () => {
    expect(toAnthropicRole("user")).toBe("user");
  });

  test("tool folds into user (Anthropic has no tool role)", () => {
    expect(toAnthropicRole("tool")).toBe("user");
  });

  test("system folds into user (caller extracts system separately before this runs)", () => {
    expect(toAnthropicRole("system")).toBe("user");
  });
});
