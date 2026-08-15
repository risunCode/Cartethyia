import { afterEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard } from "../../src/lib/clipboard";

describe("clipboard helper", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("returns false when browser clipboard APIs are unavailable", async () => {
    vi.stubGlobal("navigator", undefined);

    await expect(copyToClipboard("content")).resolves.toBe(false);
  });
});
