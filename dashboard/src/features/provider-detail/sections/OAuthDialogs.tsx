import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import {
  useCompleteOAuthBrowserLogin,
  usePollOAuthDevice,
  useProviderAccounts,
  useStartOAuthDevice,
} from "../../../hooks/providers";
import { queryKeys } from "../../../data/query-keys";
import { toast } from "../../../lib/toast";
import { useTrackedTimeout } from "../../../hooks/use-timeout";

/**
 * Extracts the authorization code from whatever the operator pasted.
 *
 * Accepts a full redirect URL, a bare query string, or the raw code. A pasted
 * URL that carries no `code` is **not** treated as a code: returning the whole
 * URL made the server send it to the token endpoint, which answered `Invalid or
 * expired code` — an error that names the code but is really a failed parse, so
 * the operator retries the same broken paste. A URL with `error` is reported
 * with the provider's own description instead, and a URL with neither is
 * rejected as an unrecognized redirect.
 */
export function extractOAuthCode(raw: string): { code: string } | { error: string } {
  const trimmed = raw.trim();
  const paramsOf = (value: string): URLSearchParams | undefined => {
    try {
      return new URL(value).searchParams;
    } catch {
      return undefined;
    }
  };
  const params =
    paramsOf(trimmed) ??
    new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
  const code = params.get("code");
  if (code) return { code };
  const providerError = params.get("error_description") ?? params.get("error");
  if (providerError) return { error: `The provider refused the login: ${providerError}` };
  // A query string or a bare code both parse to no `code` param. Only a value
  // that is recognizably a URL is refused; anything else is handed on as the
  // code the operator pasted.
  if (paramsOf(trimmed) !== undefined || trimmed.startsWith("?")) {
    return { error: "That redirect URL carries no authorization code — copy the full URL from the address bar." };
  }
  return { code: trimmed };
}

export function OAuthBrowserDialog({
  providerId,
  authorizeUrl,
  state,
  popup,
  onClose,
}: {
  readonly providerId: string;
  readonly authorizeUrl: string;
  readonly state: string;
  readonly popup: Window;
  readonly onClose: (completed: boolean) => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const [callbackValue, setCallbackValue] = useState("");
  const complete = useCompleteOAuthBrowserLogin();
  const scheduleCopyReset = useTrackedTimeout();
  const queryClient = useQueryClient();
  // The popup navigates through the hosted `/oauth/callback` route, so the
  // server completes the exchange and persists the account without the
  // dashboard ever relaying the code back. Poll the account list to detect
  // that completion and auto-close; the single-use manual-paste state
  // otherwise reads as "unknown or expired" after the popup already consumed
  // it. The manual field below stays available for redirects that landed on
  // an address the browser could not deliver back to the server.
  const accountsQuery = useProviderAccounts(providerId);
  const baselineAccountIdsRef = useRef<ReadonlySet<string> | null>(null);
  const completionDetectedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.providers.accounts(providerId),
      });
    }, 1500);
    return () => clearInterval(interval);
  }, [queryClient, providerId]);

  useEffect(() => {
    const ids = accountsQuery.data?.map((account) => account.id) ?? null;
    if (ids === null) return;
    if (baselineAccountIdsRef.current === null) {
      baselineAccountIdsRef.current = new Set(ids);
      return;
    }
    if (completionDetectedRef.current) return;
    const added = ids.find((id) => !baselineAccountIdsRef.current!.has(id));
    if (added === undefined) return;
    completionDetectedRef.current = true;
    popup.close();
    toast.success("Account connected", "OAuth login completed successfully");
    onClose(true);
  }, [accountsQuery.data, popup, onClose]);

  const cancel = () => {
    popup.close();
    onClose(false);
  };

  // Fast path for "I already approved in the popup": refresh the account
  // list now instead of waiting for the next 1.5 s tick. The completion
  // effect above closes the dialog itself when the new account arrives.
  const [checking, setChecking] = useState(false);
  const handleComplete = () => {
    setChecking(true);
    void queryClient
      .invalidateQueries({ queryKey: queryKeys.providers.accounts(providerId) })
      .finally(() => setChecking(false));
  };
  const handlePasteCallback = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast.error("Clipboard is empty");
        return;
      }
      setCallbackValue(text);
      toast.success("Pasted redirect URL");
    } catch {
      toast.error("Clipboard unavailable on this origin");
    }
  };

  const handleConnect = () => {
    const parsed = extractOAuthCode(callbackValue);
    if ("error" in parsed) {
      toast.error("OAuth callback failed", parsed.error);
      return;
    }
    complete.mutate(
      { providerId, code: parsed.code, state },
      {
        onSuccess: () => {
          popup.close();
          toast.success("Account connected", "OAuth login completed successfully");
          onClose(true);
        },
        onError: (err) =>
          toast.error(
            "OAuth callback failed",
            (err as { message?: string }).message ?? "Invalid or expired authorization code",
          ),
      },
    );
  };

  return (
    <Dialog
      open={true}
      onClose={cancel}
      title="Connect via OAuth"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={cancel} disabled={complete.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleComplete}
            disabled={complete.isPending || checking}
            title="You already approved in the popup — check now instead of waiting"
          >
            {checking ? "Checking…" : "Complete"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={complete.isPending || callbackValue.trim().length === 0}
            onClick={handleConnect}
          >
            {complete.isPending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <Stack gap="14px">
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-card border border-inner-border bg-surface-2">
          <Loader2 size={16}
           className="animate-spin text-accent shrink-0"/>
          <span className="text-body font-semibold">Waiting for popup authorization…</span>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-body font-semibold text-text-primary">Step 1: Open this URL in your browser</div>
          <Inline gap="8px">
            <a
              className="min-w-0 flex-1 font-mono text-badge text-accent overflow-hidden text-ellipsis whitespace-nowrap px-2.5 py-2 rounded-control bg-input-bg border border-inner-border"
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
              title={authorizeUrl}
            >
              {authorizeUrl}
            </a>
            <Button
              variant="secondary"
              size="sm"
              icon={copied ? <Check size={12} /> : <Copy size={12} />}
              onClick={() => {
                void navigator.clipboard?.writeText(authorizeUrl);
                setCopied(true);
                scheduleCopyReset(() => setCopied(false), 1500);
              }}
              className="shrink-0"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </Inline>
          <p className="text-badge leading-snug text-text-tertiary">
            A popup should open automatically. If it was blocked, open the URL above manually.
          </p>
        </div>

        <div className="flex items-center gap-2.5 text-micro font-bold uppercase tracking-label text-text-tertiary"><span aria-hidden="true" className="flex-1 h-px bg-inner-border" /><span>Or complete manually</span><span aria-hidden="true" className="flex-1 h-px bg-inner-border" /></div>

        <div className="flex flex-col gap-2">
          <div className="text-body font-semibold text-text-primary">Step 2: Paste the redirect URL here</div>
          <p className="text-badge leading-snug text-text-tertiary">
            If the redirect lands on an unreachable address, copy that page&apos;s full URL from
            your browser and paste it below — this works from any machine, not just localhost.
          </p>
          <Inline gap="8px" align="flex-start">
            <textarea
              value={callbackValue}
              onChange={(event) => setCallbackValue(event.target.value)}
              placeholder="http://127.0.0.1:59653/callback?code=…&state=…  (or just the code)"
              rows={2}
              spellCheck={false}
              className="w-full min-h-16 resize-y rounded-control border border-inner-border bg-input-bg px-2.5 py-2 font-mono text-badge text-text-primary box-border focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePasteCallback()}
              className="shrink-0"
            >
              Paste
            </Button>
          </Inline>
        </div>
      </Stack>
    </Dialog>
  );
}

function verificationHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function DeviceCodeDialog({
  providerId,
  parameters,
  onClose,
}: {
  readonly providerId: string;
  /** Values the provider declared for its device flow, chosen before it started. */
  readonly parameters?: Record<string, string>;
  readonly onClose: () => void;
}): ReactNode {
  const startDevice = useStartOAuthDevice();
  const pollDevice = usePollOAuthDevice();
  const [session, setSession] = useState<{
    verificationUri: string;
    userCode: string;
    deviceAuthId: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const scheduleCopyReset = useTrackedTimeout();
  useEffect(() => {
    startDevice.mutate(
      {
        providerId,
        ...(parameters === undefined || Object.keys(parameters).length === 0 ? {} : { parameters }),
      },
      {
        onSuccess: (result) => setSession(result),
        onError: (err) => {
          toast.error(
            "Failed to start device login",
            (err as { message?: string }).message ?? "Unable to start device authorization",
          );
          onClose();
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opens the verification page in a popup when the session arrives (popup
  // blockers allow it here because this effect still runs in the click
  // chain's task — the session resolves from the start-device POST the click
  // fired). Falls back to a manual Open/Copy when the popup is blocked.
  const verificationPopupRef = useRef<Window | null>(null);
  const [verificationPopupBlocked, setVerificationPopupBlocked] = useState(false);
  useEffect(() => {
    if (!session) return;
    const popup = window.open(session.verificationUri, "cartethyia-device", "popup,width=720,height=820");
    if (popup) {
      verificationPopupRef.current = popup;
    } else {
      setVerificationPopupBlocked(true);
    }
    return () => {
      const open = verificationPopupRef.current;
      verificationPopupRef.current = null;
      if (open && !open.closed) open.close();
    };
  }, [session]);

  const checkNow = () => {
    if (!session || pollDevice.isPending) return;
    pollDevice.mutate(
      { providerId, deviceAuthId: session.deviceAuthId },
      {
        onSuccess: (result) => {
          if (result.status === "complete") {
            const open = verificationPopupRef.current;
            if (open && !open.closed) open.close();
            toast.success("OAuth account connected", "Device authorization complete");
            onClose();
          } else if (result.status === "failed") {
            toast.error("Device login failed", result.reason);
            onClose();
          } else {
            toast.success("Still waiting", "The provider has not approved this device yet — approve it in the verification tab, then check again.");
          }
        },
        onError: (err) => {
          toast.error("Check failed", (err as { message?: string }).message ?? "Unable to poll device authorization");
        },
      },
    );
  };

  useEffect(() => {
    if (!session) return;
    const startedAt = Date.now();
    const expiresInMs = Math.max(1, session.expiresInSeconds) * 1000;
    let pollInFlight = false;
    let intervalMs = Math.max(1, session.intervalSeconds) * 1000;
    // `clearTimer` covers both phases: before the first poll fires `timer` is
    // a timeout, after that it is an interval. `clearInterval` alone would
    // leak the pending first poll when the dialog closes early.
    let timer = 0;
    const clearTimer = () => {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    };
    const poll = () => {
      if (Date.now() - startedAt > expiresInMs) {
        clearTimer();
        toast.error("Device login expired", "Please try again.");
        onClose();
        return;
      }
      if (pollInFlight) return;
      pollInFlight = true;
      pollDevice.mutate(
        { providerId, deviceAuthId: session.deviceAuthId },
        {
          onSuccess: (result) => {
            pollInFlight = false;
            if (result.status === "complete") {
              clearTimer();
              const open = verificationPopupRef.current;
              if (open && !open.closed) open.close();
              toast.success("OAuth account connected", "Device authorization complete");
              onClose();
            } else if (result.status === "failed") {
              clearTimer();
              toast.error("Device login failed", result.reason);
              onClose();
            } else if (result.status === "pending" && result.retryAfterSeconds !== undefined) {
              // The server echoed the provider's requested cadence: adopt it
              // so the next poll does not fire early and draw a rate limit.
              intervalMs = Math.max(1, result.retryAfterSeconds) * 1000;
              clearTimer();
              timer = window.setInterval(poll, intervalMs);
            } else if (result.status === "slow_down") {
              // The provider (GitHub especially) enforces its own minimum
              // cadence: ignoring it makes every later poll answer slow_down
              // again and the login never completes. Honour the server's
              // interval, or widen ours when it sends none.
              const nextMs =
                result.retryAfterSeconds !== undefined
                  ? Math.max(1, result.retryAfterSeconds) * 1000
                  : intervalMs + 5000;
              intervalMs = nextMs;
              clearTimer();
              timer = window.setInterval(poll, intervalMs);
            }
          },
          onError: () => {
            pollInFlight = false;
          },
        },
      );
    };
    // The first poll fires only after one full interval, never immediately:
    // the user needs those seconds to approve on the provider page, and a
    // poll that lands before any approval is possible only spends a request
    // toward the provider's rate limit (429s on an impatient first poll).
    timer = window.setTimeout(() => {
      // The timeout has served its purpose; from here the cadence is the
      // interval's. `clearTimer` still covers both handles elsewhere.
      timer = window.setInterval(poll, intervalMs);
      poll();
    }, intervalMs);
    return () => clearTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="Login with OAuth (device code)"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {session ? (
            <Button
              variant="primary"
              size="sm"
              disabled={pollDevice.isPending}
              onClick={checkNow}
              title="You already approved on the verification page — poll the provider now instead of waiting for the next interval"
            >
              {pollDevice.isPending ? "Checking…" : "Complete"}
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap="14px">
        {!session ? (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-card border border-inner-border bg-surface-2">
            <Loader2 size={16}
             className="animate-spin text-accent shrink-0"/>
            <span className="text-body font-semibold">Starting device authorization…</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-card border border-inner-border bg-surface-2">
              <Loader2 size={16}
               className="animate-spin text-accent shrink-0"/>
              <span className="text-body font-semibold">Waiting for authorization…</span>
            </div>

            {session.userCode ? (
              <div className="flex flex-col gap-2">
                <div className="text-body font-semibold text-text-primary">Step 1: Enter this code</div>
                <div className="rounded-card border border-inner-border bg-surface-2 p-3.5 flex flex-col gap-1.5 items-center text-center">
                  <div className="text-micro font-bold uppercase tracking-label text-text-tertiary">Device code</div>
                  <div className="font-mono text-2xl font-bold tracking-[0.18em] text-text-primary">{session.userCode}</div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={copiedCode ? <Check size={12} /> : <Copy size={12} />}
                    onClick={() => {
                      void navigator.clipboard?.writeText(session.userCode);
                      setCopiedCode(true);
                      scheduleCopyReset(() => setCopiedCode(false), 1500);
                    }}
                  >
                    {copiedCode ? "Copied" : "Copy code"}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <div className="text-body font-semibold text-text-primary">
                {session.userCode
                  ? "Step 2: Open the verification page"
                  : "Open the verification page to authorize"}
              </div>
              <Inline gap="8px">
                <a
                  className="min-w-0 flex-1 font-mono text-badge text-accent overflow-hidden text-ellipsis whitespace-nowrap px-2.5 py-2 rounded-control bg-input-bg border border-inner-border"
                  href={session.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  title={session.verificationUri}
                >
                  {verificationHost(session.verificationUri)}
                </a>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<ExternalLink size={12} />}
                  onClick={() => window.open(session.verificationUri, "_blank", "noopener")}
                  className="shrink-0"
                >
                  Open
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={copied ? <Check size={12} /> : <Copy size={12} />}
                  onClick={() => {
                    void navigator.clipboard?.writeText(session.verificationUri);
                    setCopied(true);
                    scheduleCopyReset(() => setCopied(false), 1500);
                  }}
                  className="shrink-0"
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </Inline>
              <p className="text-badge leading-snug text-text-tertiary">
                {verificationPopupBlocked
                  ? "The popup was blocked — open the page with Open above, finish signing in there, then press Check now."
                  : "The page opened in a popup. Finish signing in there — this dialog closes automatically once the account connects, or press Check now."}
              </p>
            </div>
          </>
        )}
      </Stack>
    </Dialog>
  );
}
