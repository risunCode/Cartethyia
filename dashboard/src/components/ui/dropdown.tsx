/* @jsxImportSource solid-js */

import { createSignal, createEffect, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "../../lib/cn";
import { createOverlayLifecycle } from "./overlay-lifecycle";

const FOCUSABLE_SELECTOR = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export interface DropdownTriggerProps {
  ref: (element: HTMLElement) => void;
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu" | "dialog" | "listbox";
  "aria-controls": string;
}

export interface DropdownProps {
  open: boolean;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
  trigger: (props: DropdownTriggerProps) => JSX.Element;
  children: JSX.Element;
  id?: string;
  align?: "start" | "end";
  offset?: number;
  className?: string;
  ariaLabel?: string;
  onExited?: () => void;
}

interface DropdownPosition {
  top: number;
  left: number;
  minWidth: number;
}

function hasReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** A controlled portal dropdown that positions against its trigger and closes safely. */
export function Dropdown(props: DropdownProps): JSX.Element {
  let triggerRef: HTMLElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<DropdownPosition>({ top: 0, left: 0, minWidth: 0 });
  const panelId = () => props.id ?? "dashboard-dropdown";
  const lifecycle = createOverlayLifecycle(
    () => props.open,
    () => props.onClose(),
    () => {
      triggerRef?.focus();
      props.onExited?.();
    },
    "popover",
  );

  const positionPanel = () => {
    if (!triggerRef || !panelRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const panelWidth = panelRef.offsetWidth;
    const panelHeight = panelRef.offsetHeight;
    const margin = 8;
    let left = props.align === "end" ? rect.right - panelWidth : rect.left;
    let top = rect.bottom + (props.offset ?? 6);
    if (top + panelHeight > window.innerHeight - margin && rect.top - panelHeight - (props.offset ?? 6) >= margin) top = rect.top - panelHeight - (props.offset ?? 6);
    left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));
    setPosition({ top, left, minWidth: rect.width });
  };

  createEffect(() => {
    if (!lifecycle.present()) return;
    const frame = requestAnimationFrame(() => {
      positionPanel();
      panelRef?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    const reposition = () => positionPanel();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef?.contains(target) || panelRef?.contains(target)) return;
      lifecycle.requestClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        lifecycle.requestClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  const setTrigger = (element: HTMLElement) => { triggerRef = element; };
  const toggleFromTrigger = () => {
    if (props.open) lifecycle.requestClose();
    else props.onOpenChange?.(true);
  };

  return (
    <>
      {props.trigger({ ref: setTrigger, onClick: toggleFromTrigger, "aria-expanded": props.open, "aria-haspopup": "menu", "aria-controls": panelId() })}
      {lifecycle.present() && (
        <Portal>
          <div
            ref={(element) => { panelRef = element; lifecycle.setElements(panelRef, panelRef); }}
            id={panelId()}
            role="menu"
            aria-label={props.ariaLabel}
            data-state={lifecycle.phase()}
            class={cn("popout-enter glass-2 z-90 max-h-[min(28rem,calc(100vh-1rem))] overflow-y-auto rounded-xl border border-[var(--glass-border)] p-1 shadow-2xl", props.className)}
            style={{ position: "fixed", top: `${position().top}px`, left: `${position().left}px`, "min-width": `${position().minWidth}px`, ...(hasReducedMotion() ? { animation: "none" } : {}) }}
          >
            {props.children}
          </div>
        </Portal>
      )}
    </>
  );
}
