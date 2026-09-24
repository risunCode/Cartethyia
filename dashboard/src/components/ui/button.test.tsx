import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";

/**
 * `size="icon"` + `label` renders a labeled icon button that collapses to a
 * square icon button via a `@container` query. The collapse itself is CSS-only
 * and invisible here, so these tests pin the DOM contract that CSS depends on.
 */
describe("Button labeled icon", () => {
  test("renders the label beside the icon and keeps aria-label authoritative", () => {
    const html = renderToStaticMarkup(
      createElement(Button, {
        size: "icon",
        icon: createElement("span", { "data-testid": "glyph" }),
        label: "Delete",
        "aria-label": "Delete rule x",
      }),
    );
    expect(html).toContain('class="btn btn-secondary btn-labeled"');
    expect(html).not.toContain('btn-icon"');
    expect(html).toContain('<span class="btn-label">Delete</span>');
    expect(html).toContain('aria-label="Delete rule x"');
  });

  test("keeps a plain icon button icon-only when no label is given", () => {
    const html = renderToStaticMarkup(
      createElement(
        Button,
        { size: "icon", icon: createElement("span"), "aria-label": "Edit rule" },
        createElement("span", { "data-testid": "legacy-child" }),
      ),
    );
    expect(html).toContain("btn-icon");
    expect(html).not.toContain("btn-labeled");
    expect(html).not.toContain("btn-label");
  });

  test("label is ignored for non-icon sizes so existing buttons are unaffected", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { size: "sm", icon: createElement("span"), label: "Should not render" }, "Visible"),
    );
    expect(html).toContain("btn-sm");
    expect(html).not.toContain("btn-label");
    expect(html).toContain("Visible");
  });
});
