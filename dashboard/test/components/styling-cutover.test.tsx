import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { Dialog } from "../../src/components/ui/dialog";
import { Drawer } from "../../src/components/ui/drawer";
import { FileInput, Input } from "../../src/components/ui/input";
import { SectionHeading, StatCard } from "../../src/components/ui/layout";
import { mount, renderMarkup } from "../helpers/render";

function classTokens(html: string, tag: string): string[] {
  const match = new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(html);
  return (match?.[1] ?? "").split(/\s+/);
}

describe("styling cutover ownership", () => {
  test("each rendered heading level owns typography, not a descendant selector", () => {
    for (const level of [1, 2, 3] as const) {
      const html = renderMarkup(createElement(SectionHeading, {
        level, title: "Heading", eyebrow: "Eyebrow", description: "Description",
      }));
      const heading = classTokens(html, `h${level}`);
      for (const token of ["font-head", "text-title", "font-bold", "tracking-[-0.02em]", "text-text-primary"]) {
        expect(heading).toContain(token);
      }
      expect(html).toMatch(/<p class="mt-1 text-caption text-text-secondary">Description<\/p>/);
      expect(html).toMatch(/<p class="text-badge[^\"]*text-text-tertiary[^\"]*">Eyebrow<\/p>/);
    }
  });

  test("stat detail stays clamped in both densities without a conflicting block utility", () => {
    for (const size of ["default", "roomy"] as const) {
      const html = renderMarkup(createElement(StatCard, {
        size, label: "Pool", value: "42", detail: "A very long pool name",
      }));
      const detail = classTokens(html, "span");
      // The label also contains spans; target the marker that owns the detail.
      const marker = /class="([^"]*stat-card-detail[^"]*)"/.exec(html)?.[1]?.split(/\s+/) ?? [];
      expect(detail.length).toBeGreaterThan(0);
      expect(marker).toContain("line-clamp-2");
      expect(marker).toContain("wrap-anywhere");
      expect(marker).not.toContain("block");
    }
  });

  test("native file input emits picker variants and preserves boundary attributes", () => {
    const html = renderMarkup(createElement(FileInput, {
      id: "art", accept: "image/png", disabled: true, "aria-label": "Art",
    }));
    const tokens = classTokens(html, "input");
    for (const token of ["form-file-input", "h-16", "text-badge", "file:h-full", "file:rounded-l-control", "file:border-r", "disabled:file:cursor-not-allowed", "file:hover:bg-surface-hover"]) {
      expect(tokens).toContain(token);
    }
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/png"');
    expect(html).toContain('aria-label="Art"');
    expect(html).toContain("disabled");
  });

  test("field label, hint, and error have their own utilities", () => {
    const html = renderMarkup(createElement(Input, { label: "Name", hint: "Required", error: "Missing", id: "name" }));
    expect(classTokens(html, "label")).toContain("text-caption");
    expect(classTokens(html, "p")).toContain("text-badge");
    expect(html).toContain("form-hint text-badge font-normal text-text-tertiary");
    expect(html).toContain('role="alert"');
  });

  test("drawer chrome retains hooks and closing state while disabling overlay clicks", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return createElement(Drawer, { open, onClose: () => setOpen(false), title: "Details", children: "Drawer body" });
    }
    const view = await mount(createElement(Harness));
    try {
      expect(view.find(".drawer-overlay")?.classList.contains("fixed")).toBe(true);
      expect(view.find(".drawer-panel")?.classList.contains("shadow-window")).toBe(true);
      expect(view.find(".drawer-panel")?.getAttribute("aria-modal")).toBe("true");
      expect(view.find(".drawer-body")?.classList.contains("overflow-y-auto")).toBe(true);
      await view.click(".drawer-close");
      expect(view.find(".drawer-overlay")?.getAttribute("data-state")).toBe("closing");
      expect(view.find(".drawer-overlay")?.classList.contains("pointer-events-none")).toBe(true);
      expect(view.find(".drawer-panel")?.classList.contains("closing")).toBe(true);
    } finally {
      view.unmount();
    }
  });

  test("dialog traffic controls own chrome and retain minimize and expand behavior", async () => {
    const view = await mount(createElement(Dialog, {
      open: true, onClose: () => {}, title: "Settings", children: "Dialog body", footer: "Actions",
    }));
    try {
      expect(view.find(".dialog-overlay")?.classList.contains("backdrop-blur-dialog")).toBe(true);
      expect(view.find(".dialog-panel")?.classList.contains("border-border-strong")).toBe(true);
      for (const name of ["close", "minimize", "expand"]) {
        const button = view.find(`.traffic-light-${name}`);
        expect(button?.classList.contains("size-7")).toBe(true);
        expect(button?.classList.contains(`bg-window-${name}`)).toBe(true);
        expect(button?.classList.contains(`text-window-${name}-ink`)).toBe(true);
      }
      await view.click(".traffic-light-minimize");
      expect(view.find(".modal-body")).toBeNull();
      expect(view.find(".modal-footer")).toBeNull();
      await view.click(".traffic-light-expand");
      expect(view.find(".dialog-panel")?.classList.contains("expanded")).toBe(true);
      expect(view.find(".modal-body")).not.toBeNull();
      expect(view.find(".modal-footer")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});
