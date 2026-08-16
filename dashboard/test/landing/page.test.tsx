import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

import { LandingPage } from "../../src/landing/page";

describe("LandingPage", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
        takeRecords = vi.fn(() => []);
        root = null;
        rootMargin = "";
        thresholds = [];
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("renders the opening chapter with typed story content", async () => {
    render(() => <LandingPage />);

    expect(screen.getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("A single signal enters");
    expect(screen.getByRole("button", { name: /go to the routing sanctum/i })).toBeInTheDocument();
  });

  test("keeps every story chapter navigable", () => {
    render(() => <LandingPage />);

    expect(screen.getAllByRole("button", { name: /go to|back to/i })).toHaveLength(7);
    expect(document.querySelector(".story")).not.toBeNull();
  });

  test("switches to a selected chapter", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    render(() => <LandingPage />);

    fireEvent.click(screen.getByRole("button", { name: /go to the routing sanctum/i }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });
});

