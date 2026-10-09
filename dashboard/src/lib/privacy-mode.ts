import { useEffect, useState } from "react";

function useStoredFlag(key: string, event: string): { readonly enabled: boolean; readonly setEnabled: (next: boolean) => void } {
  const read = () => localStorage.getItem(key) === "1";
  const [enabled, setEnabledState] = useState(read);

  useEffect(() => {
    const sync = () => setEnabledState(read());
    window.addEventListener(event, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(event, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setEnabled = (next: boolean) => {
    localStorage.setItem(key, next ? "1" : "0");
    window.dispatchEvent(new Event(event));
  };

  return { enabled, setEnabled };
}

/** Hides account emails and proxy names across the console. */
export function usePrivacyMode(): { readonly enabled: boolean; readonly setEnabled: (next: boolean) => void } {
  return useStoredFlag("cartethyia.privacy-mode", "cartethyia:privacy-mode");
}

/** Hides egress addresses on the proxy page, independent of the name switch. */
export function useMaskIp(): { readonly enabled: boolean; readonly setEnabled: (next: boolean) => void } {
  return useStoredFlag("cartethyia.mask-ip", "cartethyia:mask-ip");
}
