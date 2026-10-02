import { shareCodeMessage } from "../shared/helpers";
import { useEffect, useState } from "react";

/** Context and capabilities for one allowed model, from the model catalog. */
export interface ShareModelInfoData {
  readonly contextLength: number | null;
  readonly maxOutputTokens: number | null;
  readonly capabilities: { readonly input?: string[]; readonly output?: string[] } | null;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly webSearch: boolean;
}

/** Policy every share link carries, whichever kind it is. */
export interface ShareLinkPolicyData {
  readonly name: string;
  readonly keyPrefix: string | null;
  readonly dailyLimit: number | null;
  readonly monthlyLimit: number | null;
  readonly oneTimeLimit: number | null;
  readonly requestsPerMinute: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly modelAllowlist: string[];
  /**
   * Context window and capabilities per allowed model, keyed by the name in
   * `modelAllowlist`. A model with no catalog row is absent; the whole map is
   * absent when the link grants no specific models.
   */
  readonly modelInfo?: Record<string, ShareModelInfoData>;
  readonly modelDenylist: string[] | null;
  readonly modelPrefix: string | null;
  readonly notes: { readonly title: string | null; readonly subtitle: string | null; readonly body: string | null };
  readonly sharePopup: {
    /** True when the owner turned the popup on for this link. */
    readonly enabled: boolean;
    /** True when the owner uploaded art; fetch it from the link's image route. */
    readonly hasImage: boolean;
    readonly title: string | null;
    readonly body: string | null;
  };
  readonly expiresAt: string | null;
}

/** An enrollment link, which hands the recipient a key it can mint itself. */
export interface ShareEnrollmentData extends ShareLinkPolicyData {
  readonly kind: "enroll";
  readonly canIssue: boolean;
  readonly alreadyIssued: boolean;
}

/** A handoff link, which reveals the personal key it was created for. */
export interface ShareHandoffData extends ShareLinkPolicyData {
  readonly kind: "handoff";
  /** Null when the stored ciphertext cannot be read; the link reveals nothing. */
  readonly key: string | null;
}

export type ShareLinkData = ShareEnrollmentData | ShareHandoffData;

/** Family-wide activity for the share page's stats section. */
export interface ShareFamilyStatsData {
  readonly totals: {
    readonly requests: number;
    readonly errors: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly lastHourRequests: number;
    readonly todayTokens: number;
    readonly monthTokens: number;
  };
  readonly recipients: { readonly total: number; readonly active: number };
  readonly hourly: readonly { readonly hour: string; readonly requests: number }[];
  readonly models: readonly {
    readonly modelId: string;
    readonly requests: number;
    readonly tokens: number;
    /** Mean tokens/sec across requests that reported a rate; null when none did. */
    readonly avgTokensPerSec: number | null;
    /** Mean time-to-first-byte in ms across requests that reported it; null when none did. */
    readonly avgTtfbMs: number | null;
  }[];
  readonly clientIps: readonly {
    readonly ip: string;
    readonly requests: number;
    readonly tokens: number;
    readonly lastSeenAt: string | null;
    readonly clientType: string | null;
  }[];
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

/** Delay before re-opening a dropped share stats stream. */
const STREAM_RETRY_MS = 5_000;

/**
 * Loads the public enrollment contract without caching response bodies.
 *
 * With `streamEvent`, the path is read as a server-sent event stream instead:
 * the first matching event replaces the initial fetch and every later one
 * updates `data` in place. Stream failures fall back to re-opening the stream
 * after a short delay, and only the very first load reports `loading` — a
 * dropped stream keeps the last good reading on screen rather than blanking it.
 */
export function useShareData<TData>(
  path: string,
  options?: { readonly streamEvent?: string },
): ShareDataState<TData> {
  const streamEvent = options?.streamEvent;
  const [state, setState] = useState<ShareDataState<TData>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const apply = (payload: TData) => {
      setState({ data: payload, error: null, loading: false });
    };

    if (streamEvent === undefined) {
      void fetch(path, { signal: controller.signal, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" })
        .then(async (response) => {
          const payload = await response.json() as TData | ShareErrorResponse;
          if (!active) return;
          if (!response.ok) {
            setState({ data: null, error: errorMessage(payload as ShareErrorResponse, "This enrollment link is unavailable."), loading: false });
            return;
          }
          apply(payload as TData);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (active) setState({ data: null, error: "Unable to reach the Cartethyia gateway.", loading: false });
        });
      return () => { active = false; controller.abort(); };
    }

    // SSE mode. EventSource reconnects on its own for transient drops; this
    // loop owns the "stream ended / never opened" case so the section keeps
    // updating instead of freezing on its last frame.
    const connect = () => {
      if (!active) return;
      const next = new EventSource(path);
      source = next;
      next.addEventListener(streamEvent, (event) => {
        if (!active) return;
        try {
          apply(JSON.parse((event as MessageEvent).data) as TData);
        } catch {
          // A malformed frame is dropped; the next snapshot supersedes it.
        }
      });
      next.addEventListener("error", () => {
        next.close();
        if (!active) return;
        retryTimer = setTimeout(connect, STREAM_RETRY_MS);
      });
    };
    connect();

    return () => {
      active = false;
      source?.close();
      clearTimeout(retryTimer);
    };
  }, [path, streamEvent]);
  return state;
}
