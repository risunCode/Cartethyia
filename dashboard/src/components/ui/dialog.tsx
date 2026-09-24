import { Maximize2, Minus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../../lib/use-presence";
import { useModalFocus } from "../../lib/hooks/use-modal-focus";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Optional description text, rendered visually hidden and wired via aria-describedby. */
  description?: string;
  /** Preferred panel width in px; the panel never exceeds the viewport. Defaults to 520. */
  width?: number;
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
      className={`dialog-overlay${closing ? " closing" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`dialog-panel modal-window${closing ? " closing" : ""}${expanded ? " expanded" : ""}`}
        style={
          expanded
            ? undefined
            : { ["--dialog-width" as string]: `${width}px` }
        }
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className="modal-header">
          <div className="window-traffic-lights" role="group" aria-label="Window controls">
            <button
              type="button"
              className="traffic-light traffic-light-close"
              onClick={onClose}
              aria-label="Close dialog"
              title="Close"
            >
              <X size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="traffic-light traffic-light-minimize"
              onClick={() => setMinimized((v) => !v)}
              aria-label={minimized ? "Restore dialog" : "Minimize dialog"}
              title={minimized ? "Restore" : "Minimize"}
            >
              <Minus size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="traffic-light traffic-light-expand"
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
          <h3 id={titleId} className="modal-title">
            {title}
          </h3>
          <span className="window-traffic-lights-spacer" aria-hidden="true" />
        </div>
        {minimized ? null : <div className="modal-body">{children}</div>}
        {minimized || footer === undefined ? null : <div className="modal-footer">{footer}</div>}
        {description ? (
          <p
            id={descriptionId}
            style={{
              position: "absolute",
              width: "1px",
              height: "1px",
              padding: 0,
              margin: "-1px",
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {description}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
