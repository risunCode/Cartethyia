import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export interface ModalFocusOptions {
  /** Controlled open flag (pre-animation). */
  readonly open: boolean;
  /** Post-animation mounted flag from `usePresence`. Focus work runs while mounted. */
  readonly mounted: boolean;
  /** Ref of the modal panel element that receives initial focus and traps Tab. */
  readonly panelRef: React.RefObject<HTMLElement | null>;
  /** Called on Escape. */
  readonly onClose: () => void;
}

/**
 * Shared modal focus contract used by `Dialog`, the `Drawer`, and the command
 * palette: captures the opener on open, moves initial focus into the panel,
 * contains Tab/Shift+Tab inside the panel, closes on Escape, locks body scroll
 * while mounted, and restores focus to the opener once unmounted.
 */
export function useModalFocus({ open, mounted, panelRef, onClose }: ModalFocusOptions): void {
  const openerRef = useRef<Element | null>(null);

  // Capture the opener while it still has focus.
  useEffect(() => {
    if (open) {
      openerRef.current = typeof document !== "undefined" ? document.activeElement : null;
    }
  }, [open ]);

  // Restore focus to the opener when the modal unmounts.
  useEffect(() => {
    if (mounted) return;
    const opener = openerRef.current as HTMLElement | null;
    openerRef.current = null;
    if (opener && typeof opener.focus === "function") {
      // Defer so the opener is visible again before focus lands.
      const frame = requestAnimationFrame(() => opener.focus());
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [mounted]);

  // Body scroll lock: a property of "a modal is open", so every overlay gets
  // it from the same place rather than each one remembering to add it.
  useEffect(() => {
    if (!mounted) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mounted]);

  // Initial focus + Tab containment + Escape handling.
  useEffect(() => {
    if (!mounted) return;
    const panel = panelRef.current;
    if (panel) {
      const initial =
        panel.querySelector<HTMLElement>("[data-autofocus]") ??
        focusablesIn(panel)[0] ??
        panel;
      initial.focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusables = focusablesIn(panel);
      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mounted, onClose, panelRef]);
}
