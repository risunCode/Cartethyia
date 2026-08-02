import { describe, expect, test } from "bun:test";
import { extractResponseSample } from "../src/shared/text-utils";

describe("extractResponseSample", () => {
  test("unwraps Cline's nested data chat response", () => {
    expect(extractResponseSample({
      data: {
        choices: [{ message: { content: "CLINE_OK" } }],
      },
    })).toBe("CLINE_OK");
  });
});
