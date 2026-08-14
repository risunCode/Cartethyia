import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../../lib/clipboard";

export interface ClipboardState {
  copied: boolean;
  copy: (value: string) => Promise<boolean>;
}

/** Provides clipboard writes with a bounded copied indicator and safe fallback. */
export function useClipboard(resetAfterMs = 1500): ClipboardState {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const copy = useCallback(async (value: string): Promise<boolean> => {
    const ok = await copyToClipboard(value);
    if (!ok) return false;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, resetAfterMs);
    return true;
  }, [resetAfterMs]);

  return { copied, copy };
}
