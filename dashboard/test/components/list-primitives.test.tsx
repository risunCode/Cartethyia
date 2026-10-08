/**
 * Contract tests for the shared list-row and code-chip primitives.
 *
 * These components exist so routes stop re-declaring the same row card and
 * mono chip inline. The properties worth pinning are the class contracts the
 * CSS keys on — a rename would silently unstyle every migrated row instead of
 * failing anything — plus the structure (`leading` / body / `actions`) that
 * migrating pages depend on.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { ListRow } from "../../src/components/ui/list-row";
import { CodeChip } from "../../src/components/ui/code-chip";
import { DialogActions } from "../../src/components/ui/dialog-actions";
import { renderMarkup } from "../helpers/render";

describe("ListRow", () => {
  test("emits the list-row class and the body wrapper", () => {
    const html = renderMarkup(createElement(ListRow, null, "content"));
    expect(html).toContain("list-row");
    expect(html).toContain("list-row-body");
    expect(html).toContain("content");
  });

  test("compact density emits list-row-compact", () => {
    const html = renderMarkup(
      createElement(ListRow, { density: "compact" }, "chip"),
    );
    expect(html).toContain("list-row-compact");
    expect(html).toContain("list-row-body");
  });

  test("leading and actions render in their own wrappers", () => {
    const html = renderMarkup(
      createElement(ListRow, {
        leading: createElement("span", null, "L"),
        actions: createElement("button", null, "A"),
      }, "body"),
    );
    expect(html).toContain("list-row-leading");
    expect(html).toContain(">L<");
    expect(html).toContain("list-row-actions");
    expect(html).toContain(">A<");
  });

  test("omits leading and actions wrappers when absent", () => {
    const html = renderMarkup(createElement(ListRow, null, "body"));
    expect(html).not.toContain("list-row-leading");
    expect(html).not.toContain("list-row-actions");
  });
});

describe("CodeChip", () => {
  test("renders the value as a code element titled with it", () => {
    const html = renderMarkup(createElement(CodeChip, { value: "claude/opus-5" }));
    expect(html).toContain("code-chip");
    expect(html).toContain("code-chip-value");
    expect(html).toContain("claude/opus-5");
    expect(html).toContain('title="claude/opus-5"');
  });

  test("each tone emits its class", () => {
    for (const tone of ["plain", "muted", "accent"] as const) {
      const html = renderMarkup(
        createElement(CodeChip, { value: "x", tone }),
      );
      expect(html).toContain(`code-chip-${tone}`);
    }
  });

  test("muted is the default tone", () => {
    const html = renderMarkup(createElement(CodeChip, { value: "x" }));
    expect(html).toContain("code-chip-muted");
  });

  test("an action renders inside the chip, not as the value", () => {
    const html = renderMarkup(
      createElement(CodeChip, {
        value: "model",
        action: createElement("button", { "aria-label": "Remove model" }, "×"),
      }),
    );
    expect(html).toContain("code-chip-action");
    expect(html).toContain('aria-label="Remove model"');
  });
});

describe("DialogActions", () => {
  test("emits the dialog-actions row with its children", () => {
    const html = renderMarkup(
      createElement(DialogActions, null, createElement("button", null, "Cancel")),
    );
    expect(html).toContain("dialog-actions");
    expect(html).toContain(">Cancel<");
  });
});
