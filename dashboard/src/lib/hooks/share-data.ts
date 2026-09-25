import { shareCodeMessage } from "../helpers";
import { useEffect, useState } from "react";

export interface ShareEnrollmentData {
  readonly name: string;
  readonly keyPrefix: string | null;
  readonly canIssue: boolean;
  readonly alreadyIssued: boolean;
  readonly dailyLimit: number | null;
  readonly monthlyLimit: number | null;
  readonly oneTimeLimit: number | null;
  readonly requestsPerMinute: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: string[] | null;
  readonly modelAllowlist: string[];
  readonly modelDenylist: string[] | null;
  readonly modelPrefix: string | null;
  readonly notes: { readonly title: string | null; readonly subtitle: string | null; readonly body: string | null };
  readonly expiresAt: string | null;
}

interface ShareDataState<TData> {
  readonly data: TData | null;
  readonly error: string | null;
  readonly loading: boolean;
}

interface ShareErrorResponse {
  readonly error?: string | { readonly code?: string; readonly message?: string };
  readonly message?: string;
}

function errorMessage(payload: ShareErrorResponse, fallback: string): string {
  const rawError = payload.error;
  const code = typeof rawError === "string" ? rawError : rawError?.code;
  return shareCodeMessage(code) ?? (typeof rawError === "string" ? rawError : rawError?.message) ?? payload.message ?? fallback;
}

/** Loads the public enrollment contract without caching response bodies. */
export function useShareData<TData>(path: string): ShareDataState<TData> {
  const [state, setState] = useState<ShareDataState<TData>>({ data: null, error: null, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch(path, { signal: controller.signal, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" })
      .then(async (response) => {
        const payload = await response.json() as TData | ShareErrorResponse;
        if (!response.ok) {
          if (active) setState({ data: null, error: errorMessage(payload as ShareErrorResponse, "This enrollment link is unavailable."), loading: false });
          return;
        }
        if (active) setState({ data: payload as TData, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (active) setState({ data: null, error: "Unable to reach the Cartethyia gateway.", loading: false });
      });
    return () => { active = false; controller.abort(); };
  }, [path]);
  return state;
}
