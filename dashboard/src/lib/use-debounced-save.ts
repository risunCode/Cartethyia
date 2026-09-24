import { useEffect, useRef } from "react";

/**
 * Debounces a save callback so rapid edits (typing a number, dragging a
 * slider) collapse into one network write after `delayMs` of inactivity
 * instead of firing per keystroke. Used by auto-save numeric fields on the
 * provider/account settings pages — e.g. Routing Strategy's per-account max
 * inflight.
 */
export function useDebouncedSave<T>(save: (value: T) => void, delayMs = 600): (value: T) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Clear any pending write when the owning component unmounts so a dangling
  // timer cannot fire a save (and keep a stale closure alive) after teardown.
  useEffect(() => () => clearTimeout(timer.current), []);
  return (value: T) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(value), delayMs);
  };
}
