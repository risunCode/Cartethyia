import { Maximize2, Minus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../../hooks/use-presence";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { cn } from "../../lib/cn";

const TRAFFIC_LIGHT =
  "traffic-light grid size-7 cursor-pointer place-items-center rounded-pill border-none p-0 transition-transform duration-(--dur-micro) ease-standard hover:scale-112 focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-2";

/** Named panel size. One of the four scale steps; arbitrary px is legacy. */
export type DialogSize = "sm" | "md" | "lg" | "xl";

const DIALOG_SIZE_WIDTH: Record<DialogSize, number> = {
  sm: 420,
  md: 640,
  lg: 880,
  /** Wide data/workspace dialogs; expanded mode remains the explicit full-width escape hatch. */
  xl: 960,
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Optional description text, rendered visually hidden and wired via aria-describedby. */
  description?: string;
  /** Preferred panel width in px; the panel never exceeds the viewport. Defaults to 520. */
  width?: number;
  /** Named size step from the modal scale. Wins over width when both are set. */
  size?: DialogSize;
  /** Optional action row pinned below the scrollable body (buttons stay put). */
  footer?: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  width = 520,
  size,
  footer,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { mounted, closing } = usePresence(open);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useModalFocus({ open, mounted, panelRef, onClose });

  // Reset window chrome when the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setMinimized(false);
      setExpanded(false);
    }
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        "dialog-overlay fixed inset-0 z-drawer box-border flex items-center justify-center overflow-y-auto bg-overlay p-8 backdrop-blur-dialog max-small:p-6",
        closing && "closing pointer-events-none",
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "dialog-panel modal-window m-auto box-border flex flex-col overflow-hidden rounded-sidebar border border-border-strong bg-surface-1 shadow-window",
          closing && "closing",
          expanded && "expanded",
        )}
        style={
          expanded
            ? undefined
            : { ["--dialog-width" as string]: `${size !== undefined ? DIALOG_SIZE_WIDTH[size] : width}px` }
        }
        // `role="dialog"` is what makes the `aria-modal` and `aria-labelledby`
        // below meaningful — both are inert on a plain `div`, so without it a
        // screen-reader user gets no announcement that focus moved into a modal.
        // `drawer.tsx`, the sibling primitive, already declares the role.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          const target = event.target;
          if (target instanceof HTMLTextAreaElement) return;
          const submit = event.currentTarget.querySelector(".modal-footer .btn-primary, .modal-footer .btn-danger");
          if (!(submit instanceof HTMLButtonElement) || submit.disabled) return;
          event.preventDefault();
          submit.click();
        }}
      >
        <div className="modal-header flex items-center justify-between gap-6 border-b border-inner-border px-9 py-7">
          <div className="window-traffic-lights flex shrink-0 items-center gap-4" role="group" aria-label="Window controls">
            <button
              type="button"
              className={cn(TRAFFIC_LIGHT, "traffic-light-close bg-window-close text-window-close-ink")}
              onClick={onClose}
              aria-label="Close dialog"
              title="Close"
            >
              <X size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(TRAFFIC_LIGHT, "traffic-light-minimize bg-window-minimize text-window-minimize-ink")}
              onClick={() => setMinimized((v) => !v)}
              aria-label={minimized ? "Restore dialog" : "Minimize dialog"}
              title={minimized ? "Restore" : "Minimize"}
            >
              <Minus size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(TRAFFIC_LIGHT, "traffic-light-expand bg-window-expand text-window-expand-ink")}
              onClick={() => {
                setExpanded((v) => !v);
                setMinimized(false);
              }}
              aria-label={expanded ? "Restore dialog size" : "Expand dialog"}
              title={expanded ? "Restore" : "Expand"}
            >
              <Maximize2 size={8} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
          <h3 id={titleId} className="modal-title min-w-0 flex-1 overflow-hidden text-center text-lead font-bold text-text-primary text-ellipsis whitespace-nowrap">
            {title}
          </h3>
          <span className="window-traffic-lights-spacer w-29 shrink-0" aria-hidden="true" />
        </div>
        {minimized ? null : <div className="modal-body min-h-0 flex-auto overflow-y-auto px-9 py-8">{children}</div>}
        {minimized || footer === undefined ? null : <div className="modal-footer flex shrink-0 items-center justify-end gap-4 border-t border-inner-border px-9 py-6">{footer}</div>}
        {description ? (
          // `sr-only` is exactly the visually-hidden pattern that was inlined here
          // (1px box, clipped, no border) — the description stays available to a
          // screen reader without taking part in layout.
          <p id={descriptionId} className="sr-only">
            {description}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
