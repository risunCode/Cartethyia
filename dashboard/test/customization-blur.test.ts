/**
 * The blur defaults are a visual contract.
 *
 * `base.css` turns a (clarity, depth) pair into one backdrop blur:
 *   `blur((100 - clarity) * depth * 0.01px)`
 * so a fresh profile's glass amount is decided entirely by
 * `CUSTOMIZATION_DEFAULTS`. These cases pin the shipped defaults *and* the blur
 * they resolve to, because the numbers alone do not explain what an operator
 * sees — cards must read as glass over the page background while the chrome
 * framing them stays lighter.
 */
import { describe, expect, test } from "bun:test";
import {
  CUSTOMIZATION_DEFAULTS,
  normalizeCustomization,
} from "../src/features/customization/settings";

/**
 * The `base.css` formula, mirrored. Read from the stylesheet's own shape so a
 * change there is a deliberate edit here too.
 */
function resolvedBlurPx(clarity: number, depth: number): number {
  return (100 - clarity) * depth * 0.01;
}

describe("customization blur defaults", () => {
  test("ships the intended clarity and depth for each surface", () => {
    expect(CUSTOMIZATION_DEFAULTS.blurCardsAmount).toBe(45);
    expect(CUSTOMIZATION_DEFAULTS.blurCardsDepth).toBe(20);
    expect(CUSTOMIZATION_DEFAULTS.blurChromeAmount).toBe(25);
    expect(CUSTOMIZATION_DEFAULTS.blurChromeDepth).toBe(10);
  });

  test("cards blur harder than the chrome that frames them", () => {
    const cards = resolvedBlurPx(
      CUSTOMIZATION_DEFAULTS.blurCardsAmount,
      CUSTOMIZATION_DEFAULTS.blurCardsDepth,
    );
    const chrome = resolvedBlurPx(
      CUSTOMIZATION_DEFAULTS.blurChromeAmount,
      CUSTOMIZATION_DEFAULTS.blurChromeDepth,
    );
    expect(cards).toBe(11);
    expect(chrome).toBe(7.5);
    expect(cards).toBeGreaterThan(chrome);
  });

  test("both surfaces keep a non-zero blur on a fresh profile", () => {
    // A zero here renders an opaque surface, which is the "none" preset wearing
    // the frosted one — the failure this default is meant to avoid.
    for (const [clarity, depth] of [
      [CUSTOMIZATION_DEFAULTS.blurCardsAmount, CUSTOMIZATION_DEFAULTS.blurCardsDepth],
      [CUSTOMIZATION_DEFAULTS.blurChromeAmount, CUSTOMIZATION_DEFAULTS.blurChromeDepth],
    ] as const) {
      expect(resolvedBlurPx(clarity, depth)).toBeGreaterThan(0);
      expect(clarity).toBeLessThan(100);
    }
  });

  test("clarity and depth are independent: neither is derived from the other", () => {
    // The two axes move the same visual but not the same property, so a stored
    // profile keeps each until it is explicitly changed.
    const normalized = normalizeCustomization({
      blurCardsAmount: 10,
      blurCardsDepth: 90,
    });
    expect(normalized.blurCardsAmount).toBe(10);
    expect(normalized.blurCardsDepth).toBe(90);
    // An absent field falls back to the shipped default, not to its sibling.
    expect(normalizeCustomization({ blurCardsAmount: 10 }).blurCardsDepth).toBe(
      CUSTOMIZATION_DEFAULTS.blurCardsDepth,
    );
  });

  test("stored values stay clamped to the slider range", () => {
    const normalized = normalizeCustomization({
      blurCardsAmount: 400,
      blurChromeAmount: -20,
      blurCardsDepth: 1e9,
    });
    expect(normalized.blurCardsAmount).toBe(100);
    expect(normalized.blurChromeAmount).toBe(0);
    expect(normalized.blurCardsDepth).toBe(100);
  });
});