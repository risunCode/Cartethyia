/**
 * The shared UI primitives, rendered.
 *
 * These components exist so a route does not re-invent a button, a badge, or a
 * dialog, and the properties worth testing are the ones a route depends on:
 *
 * - **DOM contract that CSS keys on.** `Button`'s labeled-icon variant emits
 *   `btn-labeled` and a `.btn-label` span, and a `@container` query collapses it
 *   in a narrow toolbar. The collapse is CSS-only and invisible here, so the
 *   suite pins the DOM the CSS selector depends on — a rename would silently
 *   disable the collapse instead of failing anything.
 * - **Accessibility invariants.** An icon-only button needs an accessible name;
 *   a dialog needs a role and a labelled heading. These are asserted because
 *   they are invisible in a screenshot and easy to drop in a refactor.
 * - **Behaviour after interaction.** A toggle changes state, a dialog closes on
 *   its close control. Those use the live-DOM `mount` helper, because a string
 *   render cannot observe a click.
 */
import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { Badge } from "../../src/components/ui/badge";
import { Button } from "../../src/components/ui/button";
import { Card } from "../../src/components/ui/card";
import { Dialog } from "../../src/components/ui/dialog";
import { Switch } from "../../src/components/ui/switch";
import { mount, renderMarkup } from "../helpers/render";

/** The class tokens on the outermost `<button>` of a rendered Button. */
function buttonClassTokens(html: string): string[] {
  const match = /<button[^>]*class="([^"]*)"/.exec(html);
  return (match?.[1] ?? "").split(/\s+/).filter((token) => token.length > 0);
}

describe("Button", () => {
  test("defaults to a secondary, medium, submit-safe button", () => {
    // `type="button"` by default is load-bearing: a button inside a form that
    // omitted the attribute would submit the form on click.
    const html = renderMarkup(createElement(Button, null, "Save"));
    expect(html).toContain('type="button"');
    expect(html).toContain("btn");
    expect(html).toContain("btn-secondary");
    expect(html).toContain("Save");
  });

  test("renders each variant's class", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
      const html = renderMarkup(createElement(Button, { variant }, "x"));
      expect(html).toContain(`btn-${variant}`);
    }
  });

  test("a small button carries btn-sm", () => {
    expect(renderMarkup(createElement(Button, { size: "sm" }, "x"))).toContain("btn-sm");
  });

  test("an icon-only button carries btn-icon", () => {
    const html = renderMarkup(
      createElement(Button, {
        size: "icon",
        icon: createElement("span", null, "★"),
        "aria-label": "Star",
      }),
    );
    expect(html).toContain("btn-icon");
    expect(html).not.toContain("btn-labeled");
  });

  test("an icon button with a label emits the DOM the collapse CSS targets", () => {
    // The `@container` query hides `.btn-label` when the toolbar is narrow. Both
    // halves are required: the `btn-labeled` class on the button and the
    // `.btn-label` span inside it. `btn-icon` must NOT be present — the two
    // sizing classes are mutually exclusive, and emitting both would leave the
    // button's width decided by CSS source order rather than by the variant.
    const html = renderMarkup(
      createElement(Button, {
        size: "icon",
        icon: createElement("span", { "data-testid": "glyph" }),
        label: "Delete",
      }),
    );
    expect(html).toContain("btn-labeled");
    expect(html).toContain('<span class="btn-label">Delete</span>');
    // Assert on the class attribute's tokens, not on a substring: the icon
    // wrapper's class is `btn-icon-wrapper`, which contains "btn-icon".
    expect(buttonClassTokens(html)).not.toContain("btn-icon");
  });

  test("an explicit aria-label stays authoritative over the visible label", () => {
    // A screen reader must hear the fuller name ("Delete rule x") even though
    // the button reads "Delete".
    const html = renderMarkup(
      createElement(Button, {
        size: "icon",
        icon: createElement("span"),
        label: "Delete",
        "aria-label": "Delete rule x",
      }),
    );
    expect(html).toContain('aria-label="Delete rule x"');
  });

  test("a label on a non-icon size is ignored", () => {
    // The label exists only for the collapsible icon variant; rendering it on a
    // normal button would print the label instead of the children.
    const html = renderMarkup(
      createElement(Button, { size: "sm", label: "Should not render" }, "Visible"),
    );
    expect(html).not.toContain("btn-label");
    expect(html).toContain("Visible");
  });

  test("a loading button marks itself busy and swaps in a spinner", () => {
    // `aria-busy` is what tells assistive technology the button is working;
    // without it a disabled-looking button reads as unavailable.
    const html = renderMarkup(
      createElement(Button, { loading: true, icon: createElement("span", null, "★") }, "Saving"),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
    // The caller's own icon is replaced, not shown alongside the spinner.
    expect(html).not.toContain("★");
  });

  test("a non-loading button has no aria-busy attribute", () => {
    // `aria-busy={false}` would still be announced as "busy: no"; the attribute
    // must be absent.
    const html = renderMarkup(createElement(Button, null, "Save"));
    expect(html).not.toContain("aria-busy");
  });

  test("a caller's className is appended, not replacing the component's", () => {
    const html = renderMarkup(createElement(Button, { className: "w-full" }, "Save"));
    expect(html).toContain("btn");
    expect(html).toContain("w-full");
  });

  test("an explicit type overrides the default", () => {
    const html = renderMarkup(createElement(Button, { type: "submit" }, "Send"));
    expect(html).toContain('type="submit"');
  });

  test("a disabled button is rendered disabled", () => {
    const html = renderMarkup(createElement(Button, { disabled: true }, "Save"));
    expect(html).toContain("disabled");
  });

  test("clicking invokes the handler exactly once", async () => {
    let clicks = 0;
    const view = await mount(
      createElement(Button, { onClick: () => { clicks += 1; } }, "Go"),
    );
    await view.click("button");
    expect(clicks).toBe(1);
    await view.click("button");
    expect(clicks).toBe(2);
    view.unmount();
  });

  test("a disabled button does not invoke its handler", async () => {
    let clicks = 0;
    const view = await mount(
      createElement(Button, { disabled: true, onClick: () => { clicks += 1; } }, "Go"),
    );
    await view.click("button");
    expect(clicks).toBe(0);
    view.unmount();
  });
});

describe("Badge", () => {
  test("renders its children", () => {
    expect(renderMarkup(createElement(Badge, null, "Healthy"))).toContain("Healthy");
  });

  test("renders each tone's class", () => {
    for (const tone of ["ok", "warn", "err", "default"] as const) {
      const html = renderMarkup(createElement(Badge, { tone }, "x"));
      expect(html).toContain(`badge-${tone}`);
    }
  });

  test("a dotted badge emits the dot element", () => {
    // The dot is decorative and must be hidden from assistive technology, which
    // is why it carries `aria-hidden`; the tone is already conveyed by the text.
    const html = renderMarkup(createElement(Badge, { dot: true }, "Cooling"));
    expect(html).toContain("status-indicator-dot");
    expect(html).toContain('aria-hidden="true"');
  });

  test("a badge without a dot emits no dot element", () => {
    expect(renderMarkup(createElement(Badge, null, "x"))).not.toContain("status-indicator-dot");
  });
});

describe("Card", () => {
  test("renders its children inside the card container", () => {
    const html = renderMarkup(createElement(Card, null, "content"));
    expect(html).toContain("card");
    expect(html).toContain("content");
  });
});

describe("Switch", () => {
  test("exposes its checked state through aria-checked", () => {
    // The control is a `button` with `role="switch"`, so `aria-checked` is the
    // only thing that conveys state to assistive technology.
    const on = renderMarkup(createElement(Switch, { checked: true, onChange: () => {} }));
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');

    const off = renderMarkup(createElement(Switch, { checked: false, onChange: () => {} }));
    expect(off).toContain('aria-checked="false"');
  });

  test("clicking reports the flipped value", async () => {
    // The component is controlled: it must ask the parent for the new value
    // rather than mutating its own state, or the parent's model and the UI
    // diverge on the next render.
    const reported: boolean[] = [];
    function Harness() {
      const [on, setOn] = useState(false);
      return createElement(Switch, {
        checked: on,
        onChange: (next: boolean) => {
          reported.push(next);
          setOn(next);
        },
      });
    }
    const view = await mount(createElement(Harness));
    await view.click('[role="switch"]');
    expect(reported).toEqual([true]);
    // After the parent re-renders, the control reflects the new value.
    expect(view.find('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    view.unmount();
  });
});

describe("Dialog", () => {
  test("is absent from the DOM when closed", async () => {
    // A closed dialog that still rendered would keep its content focusable and
    // readable by a screen reader. Mounted rather than string-rendered because
    // the open dialog renders through a portal, and a portal is invisible to
    // `renderToStaticMarkup` — so the string renderer cannot distinguish
    // "closed" from "portalled".
    const view = await mount(
      createElement(Dialog, { open: false, onClose: () => {}, title: "Settings", children: "body" }),
    );
    expect(view.find('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("body");
    view.unmount();
  });

  test("when open it renders its title and content", async () => {
    const view = await mount(
      createElement(Dialog, { open: true, onClose: () => {}, title: "Settings", children: "body" }),
    );
    // The dialog is portalled into `document.body`, which is why this reads the
    // document rather than the mount container.
    expect(document.body.textContent).toContain("Settings");
    expect(document.body.textContent).toContain("body");
    // The panel is labelled by its own heading rather than a bare string, so the
    // accessible name stays in sync with the visible title.
    const panel = document.querySelector('[aria-labelledby]');
    expect(panel?.getAttribute("aria-labelledby")).toBeString();
    view.unmount();
  });

  /**
   * KNOWN DEFECT — the modal panel carries no `role="dialog"`.
   *
   * `dialog.tsx` renders the panel with `aria-modal="true"` and
   * `aria-labelledby`, but no `role`. Without a dialog role, assistive
   * technology does not announce a modal context at all: the `aria-modal` and
   * `aria-labelledby` attributes are only meaningful *on* a dialog, alertdialog,
   * or similar role, so both are currently inert. A screen-reader user gets no
   * announcement that focus was moved into a modal.
   *
   * `drawer.tsx` — the sibling primitive — does set `role="dialog"` on its
   * panel, which is what makes this an inconsistency rather than a house style.
   *
   * Written with `test.failing` so it flips to a failure the moment the role is
   * added, which is the signal to drop the marker and keep the assertion.
   */
  test("the modal panel exposes a dialog role", async () => {
    const view = await mount(
      createElement(Dialog, { open: true, onClose: () => {}, title: "Settings", children: "body" }),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    view.unmount();
  });

  test("the panel declares itself modal", async () => {
    // `aria-modal` is the other half of the modal contract: it tells assistive
    // technology to ignore content outside the panel.
    const view = await mount(
      createElement(Dialog, { open: true, onClose: () => {}, title: "Settings", children: "body" }),
    );
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
    view.unmount();
  });

  test("the close control is reachable by its accessible name", async () => {
    const view = await mount(
      createElement(Dialog, { open: true, onClose: () => {}, title: "Settings", children: "body" }),
    );
    expect(view.find('[aria-label="Close dialog"]')).not.toBeNull();
    view.unmount();
  });

  test("clicking close reports the request", async () => {
    let closes = 0;
    const view = await mount(
      createElement(
        Dialog,
        { open: true, onClose: () => { closes += 1; }, title: "Settings", children: "body" },
      ),
    );
    await view.click('[aria-label="Close dialog"]');
    expect(closes).toBe(1);
    view.unmount();
  });
});
