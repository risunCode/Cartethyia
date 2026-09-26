import { describe, expect, test } from "bun:test";
import {
  computerOutputToWire,
  hasOwn,
  outputToWire,
  parseResponsesComputerActionChunks,
  parseResponsesRequest,
  unwrapBody,
} from "../../../src/transport/surface/responses/parse";
import type { ContentPart } from "../../../src/transport/canonical-model";

/**
 * Direct coverage for the Responses request parser.
 *
 * `responses.test.ts` drives parsing through `ResponsesAdapter`, which only
 * reaches the content-block kinds its fixtures use. The parser accepts many
 * more — files, documents, audio, reasoning, refusals, extensions — and each is
 * a wire contract: a block the parser silently drops is content lost on the
 * next turn, so the unrecognized case is preserved as an `extension` rather
 * than discarded. These tests pin the per-kind mapping and the error boundary
 * for a malformed body.
 */

function messageInput(content: readonly unknown[]): Record<string, unknown> {
  return { model: "responses-model", input: [{ type: "message", role: "user", content }] };
}

describe("parseResponsesRequest content blocks", () => {
  test("maps an input_file block, preferring file_id over url and data", () => {
    const request = parseResponsesRequest(
      messageInput([
        {
          type: "input_file",
          filename: "notes.txt",
          file_id: "file-1",
          file_url: "https://example.test/notes.txt",
          file_data: "raw",
          mime_type: "text/plain",
        },
      ]),
    );
    const [part] = request.messages[0]!.content;
    expect(part).toMatchObject({
      kind: "file",
      filename: "notes.txt",
      file_id: "file-1",
      url: "https://example.test/notes.txt",
      media_type: "text/plain",
    });
  });

  test("an input_file block without a mime type defaults to octet-stream", () => {
    const request = parseResponsesRequest(messageInput([{ type: "input_file", file_url: "u" }]));
    expect(request.messages[0]!.content[0]).toMatchObject({
      kind: "file",
      media_type: "application/octet-stream",
    });
  });

  test("maps a document block and keeps its declared source_type", () => {
    const request = parseResponsesRequest(
      messageInput([
        {
          type: "document",
          title: "spec.pdf",
          source: { type: "base64", data: "AAA", media_type: "application/pdf" },
        },
      ]),
    );
    expect(request.messages[0]!.content[0]).toMatchObject({
      kind: "document",
      data: "AAA",
      media_type: "application/pdf",
      title: "spec.pdf",
      source_type: "base64",
    });
  });

  test("a document block falls back to the top-level mime_type", () => {
    const request = parseResponsesRequest(
      messageInput([{ type: "document", mime_type: "text/markdown", source: { file_id: "f" } }]),
    );
    expect(request.messages[0]!.content[0]).toMatchObject({
      kind: "document",
      media_type: "text/markdown",
      file_id: "f",
    });
  });

  test("maps an audio block and defaults its media type", () => {
    const request = parseResponsesRequest(
      messageInput([{ type: "input_audio", data: "AAAA" }]),
    );
    expect(request.messages[0]!.content[0]).toMatchObject({
      kind: "audio",
      data: "AAAA",
      media_type: "audio/mpeg",
    });
  });

  test("maps a refusal block", () => {
    const request = parseResponsesRequest(
      messageInput([{ type: "refusal", refusal: "I cannot do that" }]),
    );
    expect(request.messages[0]!.content[0]).toMatchObject({
      kind: "refusal",
      text: "I cannot do that",
    });
  });

  test("keeps a thinking block's chain of thought as a reasoning part", () => {
    const request = parseResponsesRequest(
      messageInput([{ type: "thinking", thinking: "step one" }]),
    );
    expect(request.messages[0]!.content[0]).toMatchObject({
      kind: "reasoning",
      payload: "step one",
      summary: "step one",
    });
  });

  test("marks a redacted_thinking block opaque instead of decoding it", () => {
    const request = parseResponsesRequest(
      messageInput([{ type: "redacted_thinking", data: "sealed" }]),
    );
    expect(request.messages[0]!.content[0]).toMatchObject({
      kind: "reasoning",
      opaque: true,
    });
  });

  test("preserves an unrecognized block as an extension rather than dropping it", () => {
    const request = parseResponsesRequest(
      messageInput([{ type: "brand_new_block", payload: { keep: true } }]),
    );
    const [part] = request.messages[0]!.content;
    expect(part).toMatchObject({ kind: "extension", name: "responses.content.brand_new_block" });
  });

  test("rejects a content block that is not an object", () => {
    expect(() => parseResponsesRequest(messageInput(["just-a-string"]))).toThrow(
      /content blocks must be objects/,
    );
  });

  test("rejects a text block with no text", () => {
    expect(() => parseResponsesRequest(messageInput([{ type: "input_text" }]))).toThrow(
      /text content blocks require text/,
    );
  });

  test("accepts a bare string input as one user message", () => {
    const request = parseResponsesRequest({ model: "m", input: "hello" });
    expect(request.messages[0]).toMatchObject({ role: "user" });
    expect(request.messages[0]!.content[0]).toMatchObject({ kind: "text", text: "hello" });
  });

  test("rejects a request without a model", () => {
    expect(() => parseResponsesRequest({ input: "hi" })).toThrow(/requires model/);
  });

  test("rejects a non-object body", () => {
    // `unwrapBody` JSON-parses a string first, so an unparseable body fails as
    // a JSON error; a parseable non-object then fails the object check.
    expect(() => parseResponsesRequest("nope")).toThrow(/JSON Parse error/);
    expect(() => parseResponsesRequest("42")).toThrow(/must be an object/);
    expect(() => parseResponsesRequest([1, 2])).toThrow(/must be an object/);
  });

  test("rejects an input that is neither a string nor an item array", () => {
    expect(() => parseResponsesRequest({ model: "m", input: 42 })).toThrow(
      /must be a string or item array/,
    );
  });

  test("rejects an unsupported message role", () => {
    expect(() =>
      parseResponsesRequest({ model: "m", input: [{ type: "message", role: "wizard", content: [] }] }),
    ).toThrow(/Unsupported Responses message role/);
  });
});

describe("parseResponsesComputerActionChunks", () => {
  test("returns an empty list for blank or non-JSON input", () => {
    expect(parseResponsesComputerActionChunks("   ")).toEqual([]);
    expect(parseResponsesComputerActionChunks("not json")).toEqual([]);
  });

  test("unwraps an actions envelope", () => {
    const actions = parseResponsesComputerActionChunks(
      JSON.stringify({ actions: [{ type: "click" }, { type: "scroll" }] }),
    );
    expect(actions).toHaveLength(2);
  });

  test("accepts a bare array and a single object", () => {
    expect(parseResponsesComputerActionChunks(JSON.stringify([{ type: "click" }]))).toHaveLength(1);
    expect(parseResponsesComputerActionChunks(JSON.stringify({ type: "click" }))).toHaveLength(1);
  });

  test("returns an empty list for a JSON scalar", () => {
    expect(parseResponsesComputerActionChunks("42")).toEqual([]);
  });
});

describe("computerOutputToWire", () => {
  test("wraps a string screenshot as a computer_screenshot", () => {
    expect(computerOutputToWire("data:image/png;base64,AAA")).toEqual({
      type: "computer_screenshot",
      image_url: "data:image/png;base64,AAA",
    });
  });

  test("carries image_url, file_id, and detail from an image part", () => {
    const parts: ContentPart[] = [
      {
        kind: "image",
        payload: { image_url: "https://example.test/a.png", file_id: "f1", detail: "high" },
      },
    ];
    expect(computerOutputToWire(parts)).toEqual({
      type: "computer_screenshot",
      image_url: "https://example.test/a.png",
      file_id: "f1",
      detail: "high",
    });
  });

  test("falls back to outputToWire when there is no image part", () => {
    const result = computerOutputToWire([{ kind: "text", text: "done" }]);
    expect(result["type"]).toBe("computer_screenshot");
    expect(Array.isArray(result["image_url"])).toBe(true);
  });
});

describe("outputToWire", () => {
  test("passes a string through unchanged", () => {
    expect(outputToWire("plain")).toBe("plain");
  });

  test("drops reasoning and refusal parts, which carry no message block", () => {
    const parts: ContentPart[] = [
      { kind: "text", text: "answer" },
      { kind: "reasoning", payload: "thought" },
      { kind: "refusal", text: "no" },
    ];
    expect(outputToWire(parts)).toEqual([{ type: "input_text", text: "answer" }]);
  });

  test("emits output_text when the part's content type says so", () => {
    const parts: ContentPart[] = [{ kind: "text", text: "hi" }];
    expect(outputToWire(parts)).toEqual([{ type: "input_text", text: "hi" }]);
  });

  test("preserves an unrecognized image source payload", () => {
    const parts: ContentPart[] = [{ kind: "image", payload: { weird: "shape" } }];
    expect(outputToWire(parts)).toEqual([{ weird: "shape" }]);
  });

  test("maps file, audio, and document parts back to their wire blocks", () => {
    const parts: ContentPart[] = [
      { kind: "file", data: "abc", media_type: "text/plain", filename: "a.txt" },
      { kind: "audio", data: "AAA", media_type: "audio/wav" },
      { kind: "document", data: "doc", media_type: "application/pdf", title: "t.pdf" },
    ];
    expect(outputToWire(parts)).toEqual([
      { type: "input_file", file_data: "abc", mime_type: "text/plain", filename: "a.txt" },
      { type: "input_audio", data: "AAA", media_type: "audio/wav" },
      { type: "input_file", file_data: "doc", mime_type: "application/pdf", filename: "t.pdf" },
    ]);
  });

  test("a document with source_type text degrades to an input_text block", () => {
    const parts: ContentPart[] = [
      { kind: "document", data: "inline text", media_type: "text/plain", source_type: "text" },
    ];
    expect(outputToWire(parts)).toEqual([{ type: "input_text", text: "inline text" }]);
  });

  test("a file carrying only a url emits file_url, not file_data", () => {
    const parts: ContentPart[] = [
      { kind: "file", data: "", url: "https://example.test/f", media_type: "text/plain" },
    ];
    expect(outputToWire(parts)).toEqual([
      { type: "input_file", file_url: "https://example.test/f", mime_type: "text/plain" },
    ]);
  });
});

describe("unwrapBody", () => {
  test("unwraps an envelope only when it carries a body plus a routing marker", () => {
    expect(unwrapBody({ body: '{"a":1}', headers: {} })).toEqual({ a: 1 });
    expect(unwrapBody({ body: '{"a":1}', path: "/v1/responses" })).toEqual({ a: 1 });
    // A `body` key without either marker is ordinary request content.
    expect(unwrapBody({ body: '{"a":1}' })).toEqual({ body: '{"a":1}' });
  });
});

describe("hasOwn", () => {
  test("distinguishes an own key from an inherited one", () => {
    expect(hasOwn({ a: 1 }, "a")).toBe(true);
    expect(hasOwn({ a: undefined }, "a")).toBe(true);
    expect(hasOwn({}, "toString")).toBe(false);
  });
});
