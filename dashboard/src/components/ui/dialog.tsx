import { Maximize2, Minus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { getExitDuration, useMotionProfile } from "../../lib/motion";

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  onExited,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onExited?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const onExitedRef = useRef(onExited);
  const closeCompletedRef = useRef(false);
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const motionProfile = useMotionProfile();
  onCloseRef.current = onClose;
  onExitedRef.current = onExited;

  const completeClose = useCallback(() => {
    if (!closing || closeCompletedRef.current) return;
    closeCompletedRef.current = true;
    setPresent(false);
    setClosing(false);
    onCloseRef.current();
    onExitedRef.current?.();
  }, [closing]);

  const requestClose = useCallback(() => {
    if (!present || closing || closeCompletedRef.current) return;
    if (motionProfile === "reduced") {
      closeCompletedRef.current = true;
      setPresent(false);
      onCloseRef.current();
      onExitedRef.current?.();
      return;
    }
    closeCompletedRef.current = false;
    setClosing(true);
  }, [closing, motionProfile, present]);

  useEffect(() => {
    if (open) {
      closeCompletedRef.current = false;
      setPresent(true);
      setClosing(false);
      setMinimized(false);
      setExpanded(false);
      return;
    }
    if (present && !closing) requestClose();
    // The close callback intentionally reads the latest refs/state while this
    // effect only reacts to the parent's open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!closing) return;
    if (motionProfile === "reduced") {
      completeClose();
      return;
    }
    const timeout = window.setTimeout(() => completeClose(), getExitDuration(motionProfile) + 40);
    return () => window.clearTimeout(timeout);
  }, [closing, completeClose, motionProfile]);

  useEffect(() => {
    if (!open || !present) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";
    const focusInitial = () => {
      if (dialogRef.current?.contains(document.activeElement)) return;
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)];
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
    requestAnimationFrame(focusInitial);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open, present, requestClose]);

  if (!present) return null;

  return createPortal(
    <div className="motion-dialog-overlay fixed inset-0 z-90 flex items-center justify-center p-4" data-state={closing ? "closed" : "open"}>
      <button type="button" aria-label="Close dialog" className="absolute inset-0 h-full w-full cursor-default bg-black/40 backdrop-blur-[6px]" onClick={requestClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-dialog-title"
        tabIndex={-1}
        data-state={closing ? "closed" : "open"}
        className={`motion-dialog-panel glass-2 relative flex w-full flex-col ${expanded ? "max-w-4xl max-h-[95vh]" : wide ? "max-w-2xl max-h-[85vh]" : "max-w-md max-h-[85vh]"} rounded-2xl p-5`}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget) completeClose();
        }}
      >
        <div className="mb-3 flex shrink-0 items-center gap-3 border-b border-[var(--inner-border)] pb-3">
          <div className="flex items-center gap-2" role="group" aria-label="Window controls">
            <button type="button" onClick={requestClose} aria-label="Close dialog" title="Close" className="grid size-3.5 place-items-center rounded-full bg-[#ff5f57] text-[#7a1c17] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff5f57]">
              <X size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "Restore dialog" : "Minimize dialog"} title={minimized ? "Restore" : "Minimize"} className="grid size-3.5 place-items-center rounded-full bg-[#febc2e] text-[#6d4b00] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#febc2e]">
              <Minus size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => { setExpanded((value) => !value); setMinimized(false); }} aria-label={expanded ? "Restore dialog size" : "Expand dialog"} title={expanded ? "Restore" : "Expand"} className="grid size-3.5 place-items-center rounded-full bg-[#28c840] text-[#0b5a22] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c840]">
              <Maximize2 size={8} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
          <h2 id="dashboard-dialog-title" className="min-w-0 flex-1 truncate text-center text-base font-bold">{title}</h2>
          <span className="w-[3.75rem]" aria-hidden="true" />
        </div>
        {!minimized && <>
          <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
        </>}
      </div>
    </div>,
    document.body,
  );
}
