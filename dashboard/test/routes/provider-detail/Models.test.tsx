import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MODEL_GROUPS, ThinkingSelect, probeThinkingOptions } from "../../../src/routes/provider-detail/Models";
import { PROBE_REASONING_EFFORTS } from "../../../src/lib/contracts";

/**
 * The Models section carries one reasoning-effort selector, and it must offer
 * exactly the vocabulary the backend accepts. A hand-written option list drifts
 * the moment the backend tuple changes, and an option the route schema rejects
 * turns a test into a validation error instead of a probe.
 */
describe("ThinkingSelect", () => {
  test("offers every backend effort, with auto labelled as the thinking setting", () => {
    // The Radix portal only renders options once open, so the vocabulary is
    // asserted on the option builder — the same list the trigger is given.
    expect(probeThinkingOptions().map((option) => option.value)).toEqual([
      ...PROBE_REASONING_EFFORTS,
    ]);
    const labels = probeThinkingOptions().map((option) => option.label);
    expect(labels[0]).toBe("Thinking: auto");
    // Every member of the backend tuple has a human label, not the raw token.
    for (const label of labels) {
      expect(label).not.toBe("");
      expect(label).not.toBe(label.toLowerCase());
    }
  });

  test("marks the trigger with the selected effort and an accessible name", () => {
    const html = renderToStaticMarkup(
      createElement(ThinkingSelect, { value: "auto", onChange: () => {} }),
    );
    expect(html).toContain("Thinking: auto");
    expect(html).toContain('aria-label="Thinking effort"');
    expect(html).toContain('id="probe-thinking-effort"');
  });

  test("honours a call-site id so the header and the dialog never share one", () => {
    const html = renderToStaticMarkup(
      createElement(ThinkingSelect, {
        value: "high",
        onChange: () => {},
        id: "models-section-thinking-effort",
      }),
    );
    expect(html).toContain('id="models-section-thinking-effort"');
    expect(html).not.toContain('id="probe-thinking-effort"');
  });
});

/**
 * The model list groups rows by where they came from. The order is the reading
 * order the operator asked for, and each row must land in exactly one group —
 * a row matching two groups would render twice, and one matching none would
 * disappear from the list entirely.
 */
describe("MODEL_GROUPS", () => {
  test("lists the groups in reading order", () => {
    expect(MODEL_GROUPS.map((group) => group.key)).toEqual([
      "builtin",
      "auto_free",
      "manual",
      "fetched",
    ]);
  });

  test("routes every source to exactly one group", () => {
    for (const source of ["builtin", "auto_free", "manual", "discovered", null]) {
      const matches = MODEL_GROUPS.filter((group) => group.matches(source));
      expect({ source, count: matches.length }).toEqual({ source, count: 1 });
    }
  });

  test("groups the four sources by name", () => {
    const groupFor = (source: string | null) =>
      MODEL_GROUPS.find((group) => group.matches(source))?.key;
    expect(groupFor(null)).toBe("builtin");
    expect(groupFor("builtin")).toBe("builtin");
    expect(groupFor("auto_free")).toBe("auto_free");
    expect(groupFor("manual")).toBe("manual");
    expect(groupFor("discovered")).toBe("fetched");
  });

  test("does not fold the free tier into the fetched group", () => {
    // The regression: a free-tier row and an ordinary fetched row are different
    // kinds of catalog entry, and collapsing them loses the distinction at the
    // only place the operator can see it.
    const fetched = MODEL_GROUPS.find((group) => group.key === "fetched");
    expect(fetched?.matches("auto_free")).toBe(false);
    expect(fetched?.matches("discovered")).toBe(true);
  });
});
