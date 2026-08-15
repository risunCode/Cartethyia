import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { LandingPage } from "../../src/landing/page";

describe("LandingPage", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders the first chapter and preloads the next image", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: "A single signal enters the unknown." })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Go to chapter/ })).toHaveLength(7);
    expect(document.querySelectorAll(".landing-scene-image")).toHaveLength(2);
    expect(document.querySelector(".landing-scene-image-current")?.getAttribute("src")).toBe("/when_yah/fleurdelys_plus.webp");
    expect(document.querySelector(".landing-scene-image-next")?.getAttribute("src")).toBe("/when_yah/cartethyia-god.webp");
  });

  test("returns to the previous image when scrolling back from the final chapter", async () => {
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
});
