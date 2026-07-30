import { useCallback, useMemo, useRef, useState, type RefObject } from "react";

/** Renders only the visible portion of a fixed-row list while preserving total scroll height. */
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
  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    setViewportHeight(element.clientHeight);
  }, []);
  const { start, end } = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const last = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
    return { start: first, end: last };
  }, [items.length, overscan, rowHeight, scrollTop, viewportHeight]);
  return { containerRef, onScroll, visibleItems: items.slice(start, end), topPadding: start * rowHeight, bottomPadding: (items.length - end) * rowHeight };
}
