import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getAllByRole("button", { name: /Go to chapter/ })).toHaveLength(7);
    expect(document.querySelectorAll(".landing-scene-image")).toHaveLength(1);
    expect(document.querySelector(".landing-scene-image")?.getAttribute("src")).toBe("/when_yah/fleurdelys_plus.webp");
  });

  test("returns to the previous image when scrolling back from the final chapter", async () => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(0));
      return 0;
    });
    render(<LandingPage />);

    const viewportHeight = window.innerHeight || 768;
    const setScrollScene = (scene: number): void => {
      Object.defineProperty(window, "scrollY", { configurable: true, value: scene * viewportHeight });
      fireEvent.scroll(window);
    };
    const loadNextImage = (): void => {
      const nextImage = document.querySelector(".landing-scene-image-next");
      if (nextImage !== null) fireEvent.load(nextImage);
    };

    for (let chapterIndex = 1; chapterIndex <= 6; chapterIndex += 1) {
      await act(async () => {
        loadNextImage();
        setScrollScene(chapterIndex);
        await Promise.resolve();
      });
    }

    expect(document.querySelector(".landing-scene-image-current")?.getAttribute("src")).toContain("Shorekeeper.webp");
    await act(async () => {
      setScrollScene(5.5);
    });

    expect(document.querySelector(".landing-scene-image-current")?.getAttribute("src")).toContain("requestdeniawokkjpg.webp");
    expect(document.querySelector(".landing-scene-image-next")?.getAttribute("src")).toContain("Shorekeeper.webp");
  });
  test("uses instant anchor scrolling when reduced motion is active", async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoViewMock });
    render(<LandingPage />);

    await userEvent.click(screen.getByRole("link", { name: /^Home$/i }));

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });
});
