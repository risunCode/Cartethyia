/* @jsxImportSource solid-js */

import { createSignal, createEffect, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Maximize2, Minus, X } from "lucide-solid";
import { createOverlayLifecycle } from "./overlay-lifecycle";

const FOCUSABLE_SELECTOR = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
  footer?: JSX.Element;
  wide?: boolean;
  onExited?: () => void;
}

function hasReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** A modal dialog with focus trapping, delayed close removal, and reduced-motion support. */
export function Dialog(props: DialogProps): JSX.Element {
  let rootRef: HTMLDivElement | undefined;
  let dialogRef: HTMLDivElement | undefined;
  let returnFocus: HTMLElement | null = null;
  let previousOverflow = "";
  const [minimized, setMinimized] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const lifecycle = createOverlayLifecycle(
    () => props.open,
    () => props.onClose(),
    () => {
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
      props.onExited?.();
    },
    "dialog",
  );

  lifecycle.setElements(rootRef, dialogRef);

  createEffect(() => {
    if (props.open) {
      setMinimized(false);
      setExpanded(false);
    }
  });

  createEffect(() => {
    if (!lifecycle.present()) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusInitial = () => {
      if (dialogRef?.contains(document.activeElement)) return;
      dialogRef?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        lifecycle.requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef) return;
      const focusable = [...dialogRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
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
    const frame = requestAnimationFrame(focusInitial);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    });
  });

  return (
    <>{lifecycle.present() && (
      <Portal>
        <div ref={(element) => { rootRef = element; lifecycle.setElements(rootRef, dialogRef); }} class="motion-dialog-overlay fixed inset-0 z-90 flex items-center justify-center p-4" data-state={lifecycle.phase()} style={hasReducedMotion() ? { animation: "none" } : undefined}>
          <button type="button" aria-label="Close dialog" class="absolute inset-0 h-full w-full cursor-default bg-black/40 backdrop-blur-[6px]" onClick={() => lifecycle.requestClose()} />
          <div
            ref={(element) => { dialogRef = element; lifecycle.setElements(rootRef, dialogRef); }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-dialog-title"
            tabIndex={-1}
            data-state={lifecycle.phase()}
            class={`motion-dialog-panel glass-2 relative flex w-full flex-col ${expanded() ? "max-w-4xl max-h-[95vh]" : props.wide ? "max-w-2xl max-h-[85vh]" : "max-w-md max-h-[85vh]"} rounded-2xl p-5`}
            style={hasReducedMotion() ? { animation: "none" } : undefined}
          >
            <div class="mb-3 flex shrink-0 items-center gap-3 border-b border-[var(--inner-border)] pb-3">
              <div class="flex items-center gap-2" role="group" aria-label="Window controls">
                <button type="button" onClick={() => lifecycle.requestClose()} aria-label="Close dialog" title="Close" class="grid size-3.5 place-items-center rounded-full bg-[#ff5f57] text-[#7a1c17] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff5f57]"><X size={9} strokeWidth={2.5} aria-hidden="true" /></button>
                <button type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized() ? "Restore dialog" : "Minimize dialog"} title={minimized() ? "Restore" : "Minimize"} class="grid size-3.5 place-items-center rounded-full bg-[#febc2e] text-[#6d4b00] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#febc2e]"><Minus size={9} strokeWidth={2.5} aria-hidden="true" /></button>
                <button type="button" onClick={() => { setExpanded((value) => !value); setMinimized(false); }} aria-label={expanded() ? "Restore dialog size" : "Expand dialog"} title={expanded() ? "Restore" : "Expand"} class="grid size-3.5 place-items-center rounded-full bg-[#28c840] text-[#0b5a22] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c840]"><Maximize2 size={8} strokeWidth={2.5} aria-hidden="true" /></button>
              </div>
              <h2 id="dashboard-dialog-title" class="min-w-0 flex-1 truncate text-center text-base font-bold">{props.title}</h2>
              <span class="w-[3.75rem]" aria-hidden="true" />
            </div>
            {!minimized() && <>
              <div class="min-w-0 flex-1 overflow-y-auto">{props.children}</div>
              {props.footer && <div class="mt-4 flex justify-end gap-2">{props.footer}</div>}
            </>}
          </div>
        </div>
      </Portal>
    )}</>
  );
}
