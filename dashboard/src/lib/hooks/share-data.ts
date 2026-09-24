import { shareCodeMessage } from "../helpers";
import { useEffect, useState } from "react";

export interface ShareApiKey {
  readonly id: string;
  readonly prefix: string;
  readonly key: string | null;
  readonly active: boolean;
}

export interface ShareNotes {
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly body: string | null;
}

export interface ShareMonitorData {
  readonly name: string;
  readonly active: boolean;
  readonly apiKey: ShareApiKey;
  readonly quotaAvailable: boolean;
  readonly dailyUsed: number;
  readonly dailyLimit: number | null;
  readonly dailyRemaining: number | null;
  readonly monthlyUsed: number;
  readonly monthlyLimit: number | null;
  readonly monthlyRemaining: number | null;
  readonly oneTimeLimit: number | null;
  readonly oneTimeUsed: number;
  readonly oneTimeRemaining: number | null;
  readonly rateLimitRpm: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: string[] | null;
  readonly modelAllowlist: string[];
  readonly modelDenylist: string[] | null;
  readonly notes: ShareNotes;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly totalTokens?: number;
  readonly totalRequests?: number;
  readonly successCount?: number;
  readonly errorCount?: number;
}

export interface ShareSetupData {
  readonly name: string;
  readonly key: string | null;
  readonly expiresAt: string | null;
}

interface ShareDataState<TData> {
  readonly data: TData | null;
  readonly error: string | null;
  readonly loading: boolean;
}

interface ShareErrorResponse {
  readonly error?: string | { readonly code?: string; readonly message?: string };
}


/** Loads a public share payload and optionally refreshes it on a fixed interval. */
export function useShareData<TData>(path: string, refreshMs?: number): ShareDataState<TData> {
  const [state, setState] = useState<ShareDataState<TData>>({ data: null, error: null, loading: true });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function load(): Promise<void> {
      try {
        const response = await fetch(path, { signal: controller.signal, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
        const payload = (await response.json()) as TData | ShareErrorResponse;
        if (!response.ok) {
          const rawError = typeof payload === "object" && payload !== null && "error" in payload ? payload.error : undefined;
          const code = typeof rawError === "string" ? rawError : rawError?.code;
          if (active) setState({ data: null, error: shareCodeMessage(code) ?? "Unable to load shared data.", loading: false });
          return;
        }
        if (active) setState({ data: payload as TData, error: null, loading: false });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (active) setState({ data: null, error: "Unable to reach the Cartethyia gateway.", loading: false });
      }
    }

    void load();
    const interval = refreshMs === undefined ? undefined : window.setInterval(() => void load(), refreshMs);
    return () => {
      active = false;
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [path, refreshMs]);

  return state;
}
