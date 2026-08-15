import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/** Renders only the visible portion of a fixed-row list while preserving total scroll height.
 *  Uses rAF-throttled scroll + ResizeObserver for viewport tracking — no jank at 50k rows. */
export function useWindowedList<T>(items: readonly T[], rowHeight: number, overscan = 4): {
  containerRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  visibleItems: readonly T[];
  topPadding: number;
  bottomPadding: number;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const rafRef = useRef<number>(0);

  const onScroll = useCallback(() => {
    if (rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const element = containerRef.current;
      if (!element) return;
      setScrollTop(element.scrollTop);
      setViewportHeight(element.clientHeight);
    });
  }, []);

  // ResizeObserver: update viewport height when container resizes (not just on scroll)
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setViewportHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { start, end } = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const last = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
    return { start: first, end: last };
  }, [items.length, overscan, rowHeight, scrollTop, viewportHeight]);

  // Cleanup rAF on unmount
  useEffect(() => () => { if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current); }, []);

  return { containerRef, onScroll, visibleItems: items.slice(start, end), topPadding: start * rowHeight, bottomPadding: (items.length - end) * rowHeight };
}
