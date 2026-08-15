import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { StatusDot } from "../../src/components/status-dot";

describe("StatusDot", () => {
  test("renders the green 'ok' indicator", () => {
    const { container } = render(<StatusDot status="ok" />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain("bg-[var(--green)]");
  });

  test("renders the orange 'warn' indicator", () => {
    const { container } = render(<StatusDot status="warn" />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain("bg-[var(--orange)]");
  });

  test("renders the neutral 'off' indicator", () => {
    const { container } = render(<StatusDot status="off" />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain("bg-[var(--text-3)]");
  });

  test("merges a custom className alongside the status color", () => {
    const { container } = render(<StatusDot status="ok" className="ml-2" />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain("ml-2");
    expect(dot?.className).toContain("bg-[var(--green)]");
  });

  test("always renders as an inline-block rounded dot regardless of status", () => {
    for (const status of ["ok", "warn", "off"] as const) {
      const { container } = render(<StatusDot status={status} />);
      const dot = container.querySelector("span");
      expect(dot?.className).toContain("inline-block");
      expect(dot?.className).toContain("rounded-full");
    }
  });
});
