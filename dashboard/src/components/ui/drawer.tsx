import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useRef, type ReactNode } from "react";
import { usePresence } from "../../hooks/use-presence";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { cn } from "../../lib/cn";

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * Right slide-in drawer (bottom sheet on small screens).
 *
 * Only the drawer chrome lives here: the overlay, the backdrop, and the sliding
 * panel. Focus trapping, Escape-to-close, body scroll-lock and opener restore
 * come from `useModalFocus` — the same contract `Dialog` uses — so the two
 * overlays cannot drift apart on keyboard behavior.
 */
export function Drawer({ open, onClose, title, children }: DrawerProps): ReactNode {
  const panelRef = useRef<HTMLElement>(null);
  const { mounted, closing } = usePresence(open, 220);
  useModalFocus({ open, mounted, panelRef, onClose });

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn("drawer-overlay fixed inset-0 z-drawer bg-overlay", closing && "closing pointer-events-none")}
      data-state={closing ? "closing" : "open"}
    >
      <button
        type="button"
        aria-label="Close drawer"
        className="drawer-backdrop absolute inset-0 h-full w-full border-none bg-transparent p-0 cursor-default"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-drawer-title"
        tabIndex={-1}
        data-state={closing ? "closing" : "open"}
        className={cn(
          "drawer-panel absolute inset-y-4 right-4 left-auto box-border flex w-224 max-w-[calc(100vw-var(--spacing)*8)] min-w-0 flex-col overscroll-contain rounded-card border border-border-strong bg-surface-1 shadow-window",
          "max-small:inset-0 max-small:h-dvh max-small:max-h-dvh max-small:w-screen max-small:max-w-full max-small:rounded-none max-small:border-none",
          closing && "closing",
        )}
      >
        <div className="drawer-header flex min-w-0 items-center justify-between gap-6 px-8 pt-7 pb-5">
          <h2 id="dashboard-drawer-title" className="drawer-title min-w-0 flex-1 truncate text-lead font-bold text-text-primary">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close drawer" className="drawer-close grid shrink-0 cursor-pointer place-items-center rounded-control border-none bg-transparent p-3 text-text-tertiary hover:bg-hover hover:text-text-primary">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-8 pb-8">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
