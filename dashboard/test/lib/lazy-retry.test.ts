import { describe, expect, test } from "bun:test";

import {
  LAZY_RETRY_TTL_MS,
  retryFlagKey,
  shouldReloadChunkLoad,
} from "../../src/lib/lazy-retry";

describe("lazy chunk retry", () => {
  test("builds a namespaced storage key per chunk", () => {
    expect(retryFlagKey("studio")).toBe("cartethyia:lazy-retry:studio");
    expect(retryFlagKey("studio")).not.toBe(retryFlagKey("proxy"));
  });

  test("reloads on first failure, missing flag, or garbage flag", () => {
    expect(shouldReloadChunkLoad(null, 1_000)).toBe(true);
    expect(shouldReloadChunkLoad("not-a-number", 1_000)).toBe(true);
    expect(shouldReloadChunkLoad("", 1_000)).toBe(false);
  });

  test("suppresses reloads inside the TTL, allows them after", () => {
    const now = 1_000_000;
    expect(shouldReloadChunkLoad(String(now), now)).toBe(false);
    expect(shouldReloadChunkLoad(String(now - LAZY_RETRY_TTL_MS + 1_000), now)).toBe(false);
    expect(shouldReloadChunkLoad(String(now - LAZY_RETRY_TTL_MS - 1_000), now)).toBe(true);
  });
});
