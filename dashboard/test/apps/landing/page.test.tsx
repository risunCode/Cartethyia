import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LandingPage } from "../../../src/apps/landing/page";

/**
 * The landing page is a pure document: every chapter renders from the static
 * `CHAPTERS` table, so the initial markup must already contain all seven story
 * sections (the IntersectionObserver only toggles reveal classes afterwards).
 */
describe("landing page", () => {
  const markup = renderToStaticMarkup(createElement(LandingPage));
  const count = (pattern: RegExp): number => (markup.match(pattern) ?? []).length;

  test("renders all seven story chapters", () => {
    expect(count(/story-page-section story-theme-/g)).toBe(7);
    expect(count(/class="story-location"/g)).toBe(7);
    expect(count(/class="story-page-visual"/g)).toBe(7);
  });

  test("applies each chapter's theme class", () => {
    for (const theme of ["night", "core", "blossom", "voices", "red", "denial", "shore"]) {
      expect(markup).toContain(`story-theme-${theme}`);
    }
  });

  test("keeps Github before All view and has no automatic scrolling", () => {
    const github = markup.indexOf(">GitHub</a>");
    const allView = markup.indexOf("All view");
    expect(github).toBeGreaterThan(-1);
    expect(github).toBeLessThan(allView);
    expect(markup).not.toContain(">Source</a>");
    expect(markup).not.toContain(">Auto</button>");
    expect(markup).not.toContain("autoscroll");
  });

  test("enters the session-aware console route instead of forcing login", () => {
    expect(markup).toContain('href="/console"');
    expect(markup).not.toContain('href="/console/login"');
  });

  test("loads chapter artwork from the public asset base", () => {
    expect(markup).toContain("when_yah/fleurdelys_plus.webp");
    expect(markup).toContain("when_yah/Shorekeeper.webp");
    expect(markup).toContain("favicon.webp");
  });
});
