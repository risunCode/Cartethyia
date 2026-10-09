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

/** Hides proxy names across the console. Account masking is per provider. */
export function usePrivacyMode(): { readonly enabled: boolean; readonly setEnabled: (next: boolean) => void } {
  return useStoredFlag("cartethyia.privacy-mode", "cartethyia:privacy-mode");
}

const MYSTERIOUS_ACCOUNTS_KEY = "cartethyia.mysterious-accounts";
const MYSTERIOUS_ACCOUNTS_EVENT = "cartethyia:mysterious-accounts";

function readMysteriousProviders(): Set<string> {
  try {
    const raw = localStorage.getItem(MYSTERIOUS_ACCOUNTS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

/** Hides account emails for one provider. The choice lives in localStorage. */
export function useMysteriousAccounts(providerId: string): { readonly enabled: boolean; readonly setEnabled: (next: boolean) => void } {
  const [providers, setProviders] = useState(readMysteriousProviders);

  useEffect(() => {
    const sync = () => setProviders(readMysteriousProviders());
    window.addEventListener(MYSTERIOUS_ACCOUNTS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(MYSTERIOUS_ACCOUNTS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setEnabled = (next: boolean) => {
    const current = readMysteriousProviders();
    if (next) current.add(providerId);
    else current.delete(providerId);
    localStorage.setItem(MYSTERIOUS_ACCOUNTS_KEY, JSON.stringify([...current]));
    window.dispatchEvent(new Event(MYSTERIOUS_ACCOUNTS_EVENT));
  };

  return { enabled: providers.has(providerId), setEnabled };
}

/** Hides egress addresses on the proxy page, independent of the name switch. */
export function useMaskIp(): { readonly enabled: boolean; readonly setEnabled: (next: boolean) => void } {
  return useStoredFlag("cartethyia.mask-ip", "cartethyia:mask-ip");
}
