import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "./card";

describe("Card surface API", () => {
  test("preserves the default solid card contract", () => {
    const markup = renderToStaticMarkup(createElement(Card, null, "Content"));

    expect(markup).toContain('class="card-solid"');
    expect(markup).not.toContain("data-depth");
    expect(markup).toContain("Content");
  });

  test("renders a per-card glass depth and elevation without inline styling", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Card,
        { glass: true, depth: 3, elevation: "popout", "aria-label": "Preview" },
        "Preview",
      ),
    );

    expect(markup).toContain('class="card-glass card-elevation-popout"');
    expect(markup).toContain('data-depth="3"');
    expect(markup).toContain('aria-label="Preview"');
    expect(markup).not.toContain("style=");
  });

  test("supports explicit flat elevation while retaining interactive behavior", () => {
    const markup = renderToStaticMarkup(
      createElement(Card, { interactive: true, elevation: "none" }, "Open"),
    );

    expect(markup).toContain('class="card-solid card-interactive card-elevation-none"');
  });
});
