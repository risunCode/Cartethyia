import { createSignal, onCleanup, type Accessor } from "solid-js";
import { copyToClipboard } from "../../lib/clipboard";

export interface ClipboardState {
  copied: Accessor<boolean>;
  copy: (value: string) => Promise<boolean>;
}

/** Provides clipboard writes with a bounded copied indicator and safe fallback. */
export function useClipboard(resetAfterMs = 1500): ClipboardState {
  const [copied, setCopied] = createSignal(false);
  let timer: number | undefined;

  onCleanup(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });

  const copy = async (value: string): Promise<boolean> => {
    const ok = await copyToClipboard(value);
    if (!ok) return false;
    setCopied(true);
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      setCopied(false);
    }, resetAfterMs);
    return true;
  };

  return { copied, copy };
}
