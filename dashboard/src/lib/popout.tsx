import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Popout — a fixed-position dropdown that portals its panel to `document.body`.
 *
 * Why a portal: the panel must escape routed layout stacking and clipping
 * contexts so its fixed coordinates stay anchored to the viewport. Portalling
 * to `document.body` keeps it on top without an animation library.
 *
 * How it avoids sizing/position jumps:
 * - The panel mounts visible, already `position: fixed` off the left edge
 *   (`left: -9999`) so it has a real layout height but is invisible.
 * - `useLayoutEffect` runs synchronously after the DOM is committed but
 *   before the browser paints, reads `offsetHeight`/`scrollWidth` from the
 *   laid-out panel, and sets the exact fixed position in one state update.
 *   The user never sees the off-screen state.
 * - A `ResizeObserver` re-measures when the panel's content changes size
 *   (e.g. async query data loads) so the panel stays anchored correctly
 *   without jumping on scroll.
 *
 * `preferUp` opens above the trigger by default (for controls in a bottom
 * composer); it flips below only when there is more room there.
 */
export function Popout({
  open,
  onClose,
  trigger,
  panel,
  panelClassName,
  width = 320,
  preferUp = false,
  matchTriggerWidth = true,
}: {
  open: boolean;
  onClose: () => void;
  trigger: (ref: React.RefObject<HTMLButtonElement | null>) => ReactNode;
  panel: (ref: React.RefObject<HTMLDivElement | null>) => ReactNode;
  panelClassName?: string;
  width?: number;
  preferUp?: boolean;
  /** Keep the panel at least as wide as its trigger unless explicitly disabled. */
  matchTriggerWidth?: boolean;
}) {

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Off-screen but laid-out: real dimensions, nothing visible to paint.
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    left: -9999,
    top: 0,
    width: `${width}px`,
    zIndex: 9999,
    visibility: "hidden",
  });

  const position = useCallback(() => {
    const triggerEl = triggerRef.current;
    const panelEl = panelRef.current;
    if (!triggerEl || !panelEl) return;
    const tr = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    // Panel width: the configured `width` is the floor. Most popouts also
    // match a wider trigger, but compact pickers opt out so a full-width form
    // control does not turn the dropdown into a viewport-wide panel.
    const minimumWidth = Math.min(width, vw - margin * 2);
    const pw = matchTriggerWidth ? Math.max(tr.width, minimumWidth) : minimumWidth;
    const ph = panelEl.offsetHeight || 0;

    const spaceBelow = vh - tr.bottom;
    const spaceAbove = tr.top;
    // preferUp → open above unless there's clearly more room below.
    // default → open below unless there's no room, then flip up.
    const flipUp = preferUp
      ? !(spaceBelow > spaceAbove && spaceBelow >= ph + margin * 2)
      : spaceBelow < ph + margin * 2 && spaceAbove >= ph + margin * 2;
    const top = flipUp ? Math.max(margin, tr.top - ph - margin) : tr.bottom + margin;
    let left: number;
    if (vw < 640) {
      left = (vw - pw) / 2;
    } else {
      left = tr.left + pw > vw - margin ? tr.right - pw : tr.left;
      if (left < margin) left = margin;
      if (left + pw > vw - margin) left = vw - pw - margin;
    }
    const maxHeight = flipUp ? Math.max(80, tr.top - margin * 2) : Math.max(80, vh - top - margin);
    setStyle({
      position: "fixed",
      left,
      top,
      width: `${pw}px`,
      maxWidth: "calc(100vw - 16px)",
      maxHeight: `${maxHeight}px`,
      zIndex: 9999,
    });
  }, [width, preferUp, matchTriggerWidth]);

  // Position synchronously before paint whenever `open` toggles or the
  // measured layout inputs change.
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ position: "fixed", left: -9999, top: 0, width: `${width}px`, zIndex: 9999, visibility: "hidden" });
      return;
    }
    position();
  }, [open, position, width]);

  // Re-measure on scroll/resize while open.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open, position]);

  // Re-measure when the panel's own size changes (async data load, search
  // filter, etc.) so the anchor stays correct without a scroll event.
  useEffect(() => {
    if (!open) return;
    const panelEl = panelRef.current;
    if (!panelEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => position());
    ro.observe(panelEl);
    return () => ro.disconnect();
  }, [open, position]);

  // Outside-click + Escape dismiss.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return <>{trigger(triggerRef)}</>;
  return (
    <>
      {trigger(triggerRef)}
      {createPortal(
        <div ref={panelRef} style={style} className={panelClassName}>
          {panel(panelRef)}
        </div>,
        document.body,
      )}
    </>
  );
}
