import { useEffect, useRef, useState } from "react";

const PULL_THRESHOLD_PX = 72;

export interface PullToRefreshState {
  /** Ref for the scrollable region that owns the gesture. */
  readonly scrollerRef: React.RefObject<HTMLElement | null>;
  /** Pixels the user has pulled past the top; 0 when idle. */
  readonly pullPx: number;
  /** True while the refresh callback is running. */
  readonly refreshing: boolean;
}

/**
 * Touch pull-to-refresh for the app's scrollable column.
 *
 * Mobile browsers only fire their native pull gesture on document scroll;
 * this dashboard scrolls inside `.app-main-column` instead, so nothing
 * happens on a phone today. This binds a touch gesture to that column and
 * calls `onRefresh` (usually `queryClient.invalidateQueries()`) once the
 * user drags past the top edge beyond the threshold.
 */
export function usePullToRefresh(onRefresh: () => Promise<unknown>): PullToRefreshState {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [pullPx, setPullPx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const gesture = useRef<{ startY: number; active: boolean }>({ startY: 0, active: false });
  // Live pull distance, updated on every move. onEnd must read this ref:
  // touchmove coalescing can jump from past the threshold straight to a
  // negative distance, and state read through the effect closure can lag a
  // sample behind, so state alone would let an aborted pull fire a refresh.
  const pullRef = useRef(0);
  const callback = useRef(onRefresh);
  callback.current = onRefresh;

  useEffect(() => {
    const scroller = scrollerRef.current ?? document.querySelector<HTMLElement>(".app-main-column");
    if (!scroller) return;
    scrollerRef.current = scroller;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      gesture.current = { startY: touch.clientY, active: scroller.scrollTop <= 0 };
      pullRef.current = 0;
      setPullPx(0);
    };
    const onMove = (event: TouchEvent) => {
      if (!gesture.current.active || refreshing) return;
      const touch = event.touches[0];
      if (!touch || scroller.scrollTop > 0) {
        gesture.current.active = false;
        pullRef.current = 0;
        setPullPx(0);
        return;
      }
      const distance = touch.clientY - gesture.current.startY;
      pullRef.current = distance > 0 ? Math.min(distance, PULL_THRESHOLD_PX * 1.5) : 0;
      setPullPx(pullRef.current);
    };
    const onEnd = () => {
      if (!gesture.current.active) return;
      gesture.current.active = false;
      if (pullRef.current >= PULL_THRESHOLD_PX && !refreshing) {
        setRefreshing(true);
        void callback
          .current()
          .catch(() => undefined)
          .finally(() => {
            setRefreshing(false);
            pullRef.current = 0;
            setPullPx(0);
          });
      } else {
        pullRef.current = 0;
        setPullPx(0);
      }
    };

    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: true });
    scroller.addEventListener("touchend", onEnd, { passive: true });
    scroller.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onEnd);
    };
  }, [refreshing]);

  return { scrollerRef, pullPx, refreshing };
}
