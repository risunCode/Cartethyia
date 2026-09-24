import { useEffect, useRef, useState } from "react";

/**
 * Keeps a modal/overlay/drawer mounted for `exitDurationMs` after `open`
 * flips to `false` so its CSS exit ("out") animation can play before the
 * DOM node is actually removed. Consumers toggle a `.closing` class while
 * `closing` is true and unmount once `mounted` goes false.
 */
export function usePresence(
  open: boolean,
  exitDurationMs = 150,
): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const mountedRef = useRef(open);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (open) {
      mountedRef.current = true;
      setClosing(false);
      setMounted(true);
      return;
    }
    if (!mountedRef.current) return;
    setClosing(true);
    timerRef.current = setTimeout(() => {
      mountedRef.current = false;
      setMounted(false);
      setClosing(false);
    }, exitDurationMs);
    return () => clearTimeout(timerRef.current);
  }, [open, exitDurationMs]);

  return { mounted, closing };
}
