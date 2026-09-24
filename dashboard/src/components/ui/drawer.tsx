import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useRef, type ReactNode } from "react";
import { usePresence } from "../../lib/use-presence";
import { useModalFocus } from "../../lib/hooks/use-modal-focus";

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
  const { mounted, closing } = usePresence(open);
  useModalFocus({ open, mounted, panelRef, onClose });

  if (!mounted) return null;

  return createPortal(
    <div className="drawer-overlay" data-state={closing ? "closing" : "open"}>
      <button
        type="button"
        aria-label="Close drawer"
        className="drawer-backdrop"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-drawer-title"
        tabIndex={-1}
        data-state={closing ? "closing" : "open"}
        className="drawer-panel"
      >
        <div className="drawer-header">
          <h2 id="dashboard-drawer-title" className="drawer-title">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close drawer" className="drawer-close">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
