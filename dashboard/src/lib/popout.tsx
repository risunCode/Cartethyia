import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export interface ElementRef<T extends HTMLElement> {
  current: T | null;
}

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
 * - Solid's post-commit effect runs after the DOM is committed; it reads
 *   `offsetHeight`/`scrollWidth` from the
 *   laid-out panel, and sets the exact fixed position in one state update.
 *   The user never sees the off-screen state.
 * - A `ResizeObserver` re-measures when the panel's content changes size
 *   (e.g. async query data loads) so the panel stays anchored correctly
 *   without jumping on scroll.
 *
 * `preferUp` opens above the trigger by default (for controls in a bottom
 * composer); it flips below only when there is more room there.
 */
export function Popout(props: {
  open: boolean;
  onClose: () => void;
  trigger: (ref: ElementRef<HTMLButtonElement>) => JSX.Element;
  panel: (ref: ElementRef<HTMLDivElement>) => JSX.Element;
  panelClassName?: string;
  width?: number;
  preferUp?: boolean;
  /** Keep the panel at least as wide as its trigger unless explicitly disabled. */
  matchTriggerWidth?: boolean;
}) {

  const triggerRef: ElementRef<HTMLButtonElement> = { current: null };
  const panelRef: ElementRef<HTMLDivElement> = { current: null };

  // Off-screen but laid-out: real dimensions, nothing visible to paint.
  const [style, setStyle] = createSignal<JSX.CSSProperties>({
    position: "fixed",
    left: "-9999px",
    top: "0px",
    width: `${props.width ?? 320}px`,
    "z-index": 9999,
    visibility: "hidden",
  });

  const position = (width = props.width ?? 320, preferUp = props.preferUp ?? false, matchTriggerWidth = props.matchTriggerWidth ?? true): void => {
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
      left: `${left}px`,
      top: `${top}px`,
      width: `${pw}px`,
      "max-width": "calc(100vw - 16px)",
      "max-height": `${maxHeight}px`,
      "z-index": 9999,
    });
  };

  // Solid commits refs before createEffect runs; keep the initial panel hidden
  // and position it in the first microtask so no off-screen state is painted.
  createEffect(() => {
    if (!props.open) {
      setStyle({ position: "fixed", left: "-9999px", top: "0px", width: `${props.width ?? 320}px`, "z-index": 9999, visibility: "hidden" });
      return;
    }
    queueMicrotask(() => position(props.width ?? 320, props.preferUp ?? false, props.matchTriggerWidth ?? true));
  });

  // Re-measure on scroll/resize while open.
  createEffect(() => {
    if (!props.open) return;
    const onScroll = (): void => position();
    const onResize = (): void => position();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    });
  });

  // Re-measure when the panel's own size changes (async data load, search
  // filter, etc.) so the anchor stays correct without a scroll event.
  createEffect(() => {
    if (!props.open) return;
    const panelEl = panelRef.current;
    if (!panelEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => position());
    ro.observe(panelEl);
    onCleanup(() => ro.disconnect());
  });

  // Outside-click + Escape dismiss.
  createEffect(() => {
    if (!props.open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      props.onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <>
      {props.trigger(triggerRef)}
      <Show when={props.open}>
        <Portal mount={document.body}>
          <div ref={(element) => { panelRef.current = element; }} style={style()} class={props.panelClassName}>
            {props.panel(panelRef)}
          </div>
        </Portal>
      </Show>
    </>
  );
}

