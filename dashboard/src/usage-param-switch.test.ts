import { describe, expect, test } from "bun:test";
import { withParam } from "./routes/Usage";

/**
 * The Usage page keeps its view state in the URL (`period`, `metric`, `dim`,
 * `scale`) and re-renders on its own every 10s, because four of its queries
 * carry `refetchInterval`. The breakdown tab appeared not to switch: a click
 * set `dim`, then a concurrent update written from an older closure restored
 * the previous value.
 *
 * `withParam` is the pure core of the fix — it derives the next params from the
 * *current* ones, so a sibling key can never be reverted by a stale snapshot.
 */
describe("Usage URL parameter updates", () => {
  test("sets one key and leaves every sibling untouched", () => {
    const current = new URLSearchParams("period=7d&metric=tokens&dim=model&scale=auto");
    const next = withParam(current, "dim", "client_ip");
    expect(next.get("dim")).toBe("client_ip");
    expect(next.get("period")).toBe("7d");
    expect(next.get("metric")).toBe("tokens");
    expect(next.get("scale")).toBe("auto");
  });

  test("does not mutate the input params", () => {
    const current = new URLSearchParams("dim=model");
    withParam(current, "dim", "provider");
    expect(current.get("dim")).toBe("model");
  });

  test("switching dimension repeatedly always lands on the last click", () => {
    // The regression shape: interleaved updates must not resurrect an older
    // value, which is what a stale-snapshot write did.
    let params = new URLSearchParams("dim=model");
    for (const dimension of ["provider", "client", "client_ip", "key", "model"]) {
      params = withParam(params, "dim", dimension);
      expect(params.get("dim")).toBe(dimension);
    }
    expect(params.get("dim")).toBe("model");
  });

  test("a dimension switch preserves an unrelated concurrent write", () => {
    // Simulates the race: the period changes from a fresh read while the
    // dimension changes from the current params. Both must survive.
    let params = new URLSearchParams("dim=model&period=24h");
    params = withParam(params, "period", "30d");
    params = withParam(params, "dim", "client_ip");
    expect(params.get("dim")).toBe("client_ip");
    expect(params.get("period")).toBe("30d");
  });
});
