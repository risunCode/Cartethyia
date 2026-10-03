import { describe, expect, test } from "bun:test";
import {
  appliedThinkingLevel,
  thinkingLadder,
  thinkingLevelOptions,
  thinkingLevelSupported,
  unionThinkingLadder,
  type ThinkingWireFamily,
} from "../../src/shared/thinking-ladder";

/**
 * The dashboard pickers must agree with the backend ladder. These assertions pin
 * the mapping `(model, wire, reasoning) -> levels`, so a backend ladder change
 * the pickers do not follow fails here instead of silently offering a level the
 * router will clamp away.
 *
 * Expected values were read off `resolveSupportedReasoningEfforts` in
 * `src/transport/translation/thinking.ts` (the function these helpers call).
 */

const MODEL = (modelId: string, wireFamily: ThinkingWireFamily, reasoning: boolean) =>
  ({ modelId, wireFamily, reasoning }) as const;

/** A picker option, shaped like the ones Studio/Models pass in. */
const OPT = (value: string) => ({ value, label: value });

const BASE = ["auto", "low", "medium", "high", "xhigh", "max"].map(OPT);

describe("thinkingLadder", () => {
  test("a model without reasoning support has no levels", () => {
    const ladder = thinkingLadder(MODEL("gpt-4o", "chat", false));
    expect(ladder.supported).toEqual([]);
    expect(ladder.unsupported).toBe(true);
  });

  test("the reasoning flag wins over the model name", () => {
    // Same id, opposite flag: the ladder must follow the flag, not the id.
    expect(thinkingLadder(MODEL("gpt-5.5", "responses", false)).supported).toEqual([]);
    expect(thinkingLadder(MODEL("gpt-5.5", "responses", true)).supported).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("an unknown model keeps the widest ladder (permissive)", () => {
    expect(thinkingLadder(MODEL("no-such-model", "chat", true)).supported).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("the wire family narrows the ladder", () => {
    // `amu-tunga` is widest on chat; responses drops the `max` rung.
    expect(thinkingLadder(MODEL("amu-tunga", "chat", true)).supported).toContain("max");
    expect(thinkingLadder(MODEL("amu-tunga", "responses", true)).supported).not.toContain("max");
  });

  test("narrow ladders are reported per model", () => {
    expect(thinkingLadder(MODEL("mimo-v2.6", "chat", true)).supported).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(thinkingLadder(MODEL("claude-opus-4-6", "chat", true)).supported).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(thinkingLadder(MODEL("gemini-3-pro", "chat", true)).supported).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("appliedThinkingLevel", () => {
  test("auto carries no intent, so nothing is applied", () => {
    const ladder = thinkingLadder(MODEL("mimo-v2.6", "chat", true));
    expect(appliedThinkingLevel("auto", ladder)).toBeUndefined();
  });

  test("a supported level is applied unchanged", () => {
    const ladder = thinkingLadder(MODEL("amu-tunga", "chat", true));
    expect(appliedThinkingLevel("max", ladder)).toBe("max");
  });

  test("an unsupported level clamps down to the nearest supported rung", () => {
    const ladder = thinkingLadder(MODEL("mimo-v2.6", "chat", true));
    expect(appliedThinkingLevel("max", ladder)).toBe("high");
    expect(appliedThinkingLevel("xhigh", ladder)).toBe("high");
    // Below the floor it clamps up to the floor, not down to nothing.
    expect(appliedThinkingLevel("minimal", ladder)).toBe("low");
  });

  test("a model without reasoning applies nothing", () => {
    const ladder = thinkingLadder(MODEL("gpt-4o", "chat", false));
    expect(appliedThinkingLevel("high", ladder)).toBeUndefined();
  });
});

describe("thinkingLevelOptions", () => {
  test("a model without reasoning disables every level but auto", () => {
    const options = thinkingLevelOptions(BASE, thinkingLadder(MODEL("gpt-4o", "chat", false)));
    expect(options.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["auto"]);
  });

  test("a narrow model disables exactly the levels above its ceiling", () => {
    const options = thinkingLevelOptions(BASE, thinkingLadder(MODEL("mimo-v2.6", "chat", true)));
    expect(options.filter((o) => o.disabled).map((o) => o.value)).toEqual(["xhigh", "max"]);
  });

  test("with no ladder the picker stays permissive (combo/alias)", () => {
    // `unionThinkingLadder([])` is the permissive ladder combo/alias rows fall to.
    const permissive = unionThinkingLadder([]);
    const options = thinkingLevelOptions(BASE, permissive);
    expect(options.every((o) => !o.disabled)).toBe(true);
  });

  test("the base list is preserved in order, labels intact", () => {
    const options = thinkingLevelOptions(BASE, thinkingLadder(MODEL("gpt-4o", "chat", false)));
    expect(options.map((o) => o.value)).toEqual(BASE.map((o) => o.value));
    expect(options[0]!.label).toBe("auto");
  });
});

describe("thinkingLevelSupported", () => {
  test("agrees with the ladder contents", () => {
    const ladder = thinkingLadder(MODEL("mimo-v2.6", "chat", true));
    expect(thinkingLevelSupported(ladder, "high")).toBe(true);
    expect(thinkingLevelSupported(ladder, "max")).toBe(false);
  });

  test("auto is always allowed, even with no ladder", () => {
    expect(thinkingLevelSupported(thinkingLadder(MODEL("gpt-4o", "chat", false)), "auto")).toBe(
      true,
    );
  });
});

describe("unionThinkingLadder", () => {
  test("intersects so the section picker never offers a level some card cannot honor", () => {
    const union = unionThinkingLadder([
      MODEL("gpt-4o", "chat", false),
      MODEL("mimo-v2.6", "chat", true),
    ]);
    expect(union.supported).toEqual([]);
    expect(union.unsupported).toBe(true);
  });

  test("keeps the levels every model shares", () => {
    const union = unionThinkingLadder([
      MODEL("mimo-v2.6", "chat", true),
      MODEL("claude-opus-4-6", "chat", true),
    ]);
    expect(union.supported).toEqual(["low", "medium", "high"]);
    expect(union.unsupported).toBe(false);
  });

  test("an empty section is permissive, not empty", () => {
    expect(unionThinkingLadder([]).unsupported).toBe(false);
  });
});
