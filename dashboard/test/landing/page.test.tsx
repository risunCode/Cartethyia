import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LandingPage } from "../../src/landing/page";

describe("LandingPage motion contracts", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  test("renders the first chapter and all chapter navigation controls", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: "A single signal enters the unknown." })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Go to chapter/ })).toHaveLength(4);
  });
  test("uses instant anchor scrolling when reduced motion is active", async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoViewMock });
    render(<LandingPage />);

    await userEvent.click(screen.getByRole("link", { name: /^Home$/i }));

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });
});
