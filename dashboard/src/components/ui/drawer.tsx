import { AnimatePresence, m } from "framer-motion";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { getDrawerMotion, useMotionProfile } from "../../lib/motion";

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const drawerMotion = getDrawerMotion(useMotionProfile());
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const selector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(selector)];
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
    requestAnimationFrame(() => {
      if (drawerRef.current?.contains(document.activeElement)) return;
      drawerRef.current?.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open]);

  // Portalled for the same reason as Dialog — see the note there.
  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div className="fixed inset-0 z-90" {...drawerMotion.overlay}>
          <button type="button" aria-label="Close drawer" className="absolute inset-0 h-full w-full cursor-default bg-black/40 backdrop-blur-[6px]" onClick={onClose} />
          <m.aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-drawer-title"
            tabIndex={-1}
            className="glass-2 absolute inset-x-2 top-2 bottom-2 flex w-auto min-w-0 flex-col rounded-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] overscroll-contain sm:inset-y-4 sm:right-4 sm:left-auto sm:w-full sm:max-w-md sm:p-5"
            {...drawerMotion.panel}
          >
            <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
              <h2 id="dashboard-drawer-title" className="min-w-0 truncate text-base font-bold">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close drawer"
                className="rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>
          </m.aside>
        </m.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
