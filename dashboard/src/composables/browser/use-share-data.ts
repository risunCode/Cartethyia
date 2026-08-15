import { createSignal, createEffect, onCleanup, type Accessor } from "solid-js";

export interface ShareApiKey {
  readonly id: string;
  readonly prefix: string;
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
  readonly inFlight: number;
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
  readonly providerAllowlist: string | null;
  readonly modelAllowlist: string | null;
  readonly modelDenylist: string | null;
  readonly notes: ShareNotes;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly baseUrl: string;
}

export interface ShareSetupData {
  readonly name: string;
  readonly key: string;
  readonly baseUrl: string;
  readonly expiresAt: string;
}

export interface ShareDataState<TData> {
  readonly data: Accessor<TData | null>;
  readonly error: Accessor<string | null>;
  readonly loading: Accessor<boolean>;
}

interface ShareErrorResponse {
  readonly error?: string;
}

function errorMessage(code: string | undefined, fallback: string): string {
  if (code === "link_expired_or_used") return "This setup link is expired or already used.";
  if (code === "key_unavailable") return "The API key is no longer available.";
  if (code === "link_not_found") return "This shared passage is unavailable.";
  return fallback;
}

/** Loads a public share payload and optionally refreshes it on a fixed interval. */
export function useShareData<TData>(path: string, refreshMs?: number): ShareDataState<TData> {
  const [data, setData] = createSignal<TData | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  createEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function load(): Promise<void> {
      try {
        const response = await fetch(path, { signal: controller.signal, credentials: "same-origin" });
        const payload = (await response.json()) as TData | ShareErrorResponse;
        if (!response.ok) {
          const code = typeof payload === "object" && payload !== null && "error" in payload ? payload.error : undefined;
          if (active) {
            setData(null);
            setError(errorMessage(code, "Unable to load shared data."));
            setLoading(false);
          }
          return;
        }
        if (active) {
          setData(() => payload as TData);
          setError(null);
          setLoading(false);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (active) {
          setData(null);
          setError("Unable to reach the Cartethyia gateway.");
          setLoading(false);
        }
      }
    }

    void load();
    const interval = refreshMs === undefined ? undefined : window.setInterval(() => void load(), refreshMs);
    onCleanup(() => {
      active = false;
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    });
  });

  return { data, error, loading };
}
