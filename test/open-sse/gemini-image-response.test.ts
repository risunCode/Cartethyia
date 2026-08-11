import { describe, expect, test } from "bun:test";
import { translateGeminiImageResponse } from "../../src/open-sse/translate/response/gemini";

describe("Gemini image response translation", () => {
  test("preserves inline image base64, mime type, prompt text, and response id", () => {
    const result = translateGeminiImageResponse({
      responseId: "response-image-1",
      candidates: [{
        content: {
          parts: [
            { text: "A polished red apple" },
            { inlineData: { mimeType: "image/png", data: "AAAA" } },
          ],
        },
      }],
    });

    expect(result).toMatchObject({
      id: "response-image-1",
      revised_prompt: "A polished red apple",
      data: [{ b64_json: "AAAA", mime_type: "image/png" }],
    });
  });

});
