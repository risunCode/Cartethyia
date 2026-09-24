import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a `setTimeout` equivalent whose pending timers are cleared when the
 * owning component unmounts. Use for fire-and-forget UI affordances (e.g.
 * "Copied" feedback resets) so an unmounted component never receives a
 * delayed state update.
 */
export function useTrackedTimeout(): (fn: () => void, delayMs: number) => void {
  const ids = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const id of ids.current) window.clearTimeout(id);
      ids.current = [];
    },
    [],
  );

  return useCallback((fn: () => void, delayMs: number) => {
    ids.current.push(window.setTimeout(fn, delayMs));
  }, []);
}
