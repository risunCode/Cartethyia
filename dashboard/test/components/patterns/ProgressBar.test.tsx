import { describe, expect, test } from "vitest";
import { render } from "@solidjs/testing-library";
import { ProgressBar } from "../../../src/components/patterns/progress-bar";

describe("ProgressBar", () => {
  test("applies the shared bar-transition class to the fill element", () => {
    const { container } = render(() => <ProgressBar value={40} max={100} />);

    const fill = container.querySelector('[role="progressbar"] > div');
    expect(fill).not.toBeNull();
    expect(fill?.className).toContain("bar-transition");
  });

  test("fills proportionally to the supplied value and max", () => {
    const { container } = render(() => <ProgressBar value={25} max={100} />);

    const fill = container.querySelector('[role="progressbar"] > div') as HTMLElement | null;
    expect(fill).not.toBeNull();
    // scaleX(0.25) — 25% of the track.
    expect(fill?.style.transform).toContain("scaleX(0.25)");
  });

  test("clamps to 0 when value is negative or missing", () => {
    const { container } = render(() => <ProgressBar value={undefined} />);

    const fill = container.querySelector('[role="progressbar"] > div') as HTMLElement | null;
    expect(fill?.style.transform).toContain("scaleX(0)");
  });

  test("reflects value and max on the progressbar role", () => {
    const { container } = render(() => <ProgressBar value={60} max={200} showValue />);

    const bar = container.querySelector('[role="progressbar"]') as HTMLElement | null;
    expect(bar?.getAttribute("aria-valuemax")).toBe("200");
    expect(bar?.getAttribute("aria-valuenow")).toBe("60");
  });
});
