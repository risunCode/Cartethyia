/* @jsxImportSource solid-js */

import { createEffect, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { createOverlayLifecycle } from "./overlay-lifecycle";

const FOCUSABLE_SELECTOR = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
  onExited?: () => void;
}

function hasReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** A right-side modal drawer with focus trapping and transition-safe removal. */
export function Drawer(props: DrawerProps): JSX.Element {
  let rootRef: HTMLDivElement | undefined;
  let drawerRef: HTMLElement | undefined;
  let returnFocus: HTMLElement | null = null;
  let previousOverflow = "";
  const lifecycle = createOverlayLifecycle(
    () => props.open,
    () => props.onClose(),
    () => {
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
      props.onExited?.();
    },
    "drawer",
  );

  createEffect(() => {
    if (!lifecycle.present()) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        lifecycle.requestClose();
        return;
      }
      if (event.key !== "Tab" || !drawerRef) return;
      const focusable = [...drawerRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => {
      if (!drawerRef?.contains(document.activeElement)) drawerRef?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    });
  });

  return (
    <>{lifecycle.present() && (
      <Portal>
        <div ref={(element) => { rootRef = element; lifecycle.setElements(rootRef, drawerRef); }} class="motion-drawer-overlay fixed inset-0 z-90" data-state={lifecycle.phase()} style={hasReducedMotion() ? { animation: "none" } : undefined}>
          <button type="button" aria-label="Close drawer" class="absolute inset-0 h-full w-full cursor-default bg-black/40 backdrop-blur-[6px]" onClick={() => lifecycle.requestClose()} />
          <aside
            ref={(element) => { drawerRef = element; lifecycle.setElements(rootRef, drawerRef); }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-drawer-title"
            tabIndex={-1}
            data-state={lifecycle.phase()}
            class="motion-drawer-panel glass-2 absolute inset-x-2 top-2 bottom-2 flex w-auto min-w-0 flex-col rounded-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] overscroll-contain sm:inset-y-4 sm:right-4 sm:left-auto sm:w-full sm:max-w-md sm:p-5"
            style={hasReducedMotion() ? { animation: "none" } : undefined}
          >
            <div class="mb-3 flex min-w-0 items-center justify-between gap-3">
              <h2 id="dashboard-drawer-title" class="min-w-0 truncate text-base font-bold">{props.title}</h2>
              <button type="button" onClick={() => lifecycle.requestClose()} aria-label="Close drawer" class="rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]"><X size={16} /></button>
            </div>
            <div class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{props.children}</div>
          </aside>
        </div>
      </Portal>
    )}</>
  );
}
