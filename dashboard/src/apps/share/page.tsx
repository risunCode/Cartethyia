import { useEffect, useState, type ReactElement } from "react";
import { Home, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { readConsoleTheme, applyConsoleTheme } from "../../lib/theme";
import { useShareData, type ShareEnrollmentData } from "../../lib/hooks/share-data";
import {
  deleteStoredShareKey,
  readStoredShareKey,
  writeStoredShareKey,
  type StoredShareKey,
} from "../../lib/share-key-storage";

interface IssueResult { key: string; keyId: string; keyPrefix: string; createdAt: string }
interface ApiError { error?: string | { code?: string; message?: string }; message?: string }
function message(payload: ApiError): string {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? payload.message ?? "Unable to generate an API key.";
}
function fmt(value: number | null): string { return value === null ? "Unlimited" : value.toLocaleString(); }

export function tokenFromPathname(pathname: string): string {
  const path = pathname.replace(/\/$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

export function SharePage(): ReactElement {
  const path = typeof window === "undefined" ? "/share" : window.location.pathname.replace(/\/$/, "");
  const dataPath = `${path}/data`;
  const issuePath = `${path}/issue`;
  const enrollmentToken = typeof window === "undefined" ? "" : tokenFromPathname(path);
  // The gateway cannot know the origin a share page is reached by — a tunnel, a
  // reverse proxy, or the operator's own public origin can all differ from the
  // request's view. The browser is the only party that knows for certain, so
  // the endpoint the recipient is told to call is derived here.
  const baseUrl = typeof window === "undefined" ? "" : window.location.origin;
  const state = useShareData<ShareEnrollmentData>(dataPath);
  const [secret, setSecret] = useState<IssueResult | null>(null);
  const [restoredSecret, setRestoredSecret] = useState<StoredShareKey | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueConflict, setIssueConflict] = useState(false);
  useEffect(() => {
    document.title = "Cartethyia — Shared access";
    // The public share surface owns no theme of its own: it applies the console
    // `console-theme` preference through the same helper the console uses, so
    // both apps on this origin always resolve to the same tokens. The bootstrap
    // in `index.html` resolves the same key before the bundle loads.
    applyConsoleTheme(readConsoleTheme());
  }, []);
  useEffect(() => {
    let active = true;
    setSecret(null);
    setRestoredSecret(null);
    setStorageWarning(null);
    if (!enrollmentToken) return;
    if (state.loading || state.error || !state.data) {
      if (state.error) {
        void deleteStoredShareKey(enrollmentToken).catch(() => undefined);
      }
      return;
    }
    void readStoredShareKey(enrollmentToken)
      .then((stored) => {
        if (active && stored) {
          setRestoredSecret(stored);
          setSecret(null);
        }
      })
      .catch(() => {
        if (active) {
          setStorageWarning("This browser could not read the stored key. Issue a new key only if this enrollment permits one.");
        }
      });
    return () => { active = false; };
  }, [enrollmentToken, state.loading, state.error, state.data]);
  const issue = async () => {
    setIssueBusy(true);
    setIssueError(null);
    setStorageWarning(null);
    try {
      const response = await fetch(issuePath, { method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: "{}" });
      const payload = await response.json() as IssueResult | ApiError;
      if (!response.ok) {
        if (response.status === 409) setIssueConflict(true);
        setIssueError(response.status === 409 ? "A recipient from this IP already has an active key for a share. This link cannot issue another key." : message(payload as ApiError));
        return;
      }
      const issued = payload as IssueResult;
      setRestoredSecret(null);
      setSecret(issued);
      if (!enrollmentToken) return;
      try {
        await writeStoredShareKey(enrollmentToken, {
          key: issued.key,
          keyId: issued.keyId,
          keyPrefix: issued.keyPrefix,
          createdAt: issued.createdAt,
        });
        setRestoredSecret({
          key: issued.key,
          keyId: issued.keyId,
          keyPrefix: issued.keyPrefix,
          createdAt: issued.createdAt,
        });
        setSecret(null);
      } catch {
        setStorageWarning("Your key was issued, but this browser could not save it. Copy it now: refreshing will not restore it.");
      }
    } catch {
      setIssueError("Unable to reach the Cartethyia gateway. Please try again.");
    } finally { setIssueBusy(false); }
  };
  const visibleSecret = restoredSecret ?? secret;
  const data = state.data;
  const canIssue = Boolean(data?.canIssue) && !data?.alreadyIssued && !issueConflict;
  return (
    <div className="share-page">
      <header className="share-topbar">
        <a className="share-brand" href="/">
          <span className="share-brand-mark" aria-hidden="true">
            <ShieldCheck size={16} />
          </span>
          <b>Cartethyia</b>
        </a>
        <a href="/" className="share-home-link">
          <Home size={12} aria-hidden="true" /> Home
        </a>
      </header>
      <main className="share-main">
        {state.loading ? (
          <Card>
            <CardBody>
              <LoadingState label="Loading enrollment policy…" />
            </CardBody>
          </Card>
        ) : state.error ? (
          <Card>
            <CardBody>
              <ErrorState
                title="Link not available"
                message={state.error}
                onRetry={() => window.location.reload()}
              />
            </CardBody>
          </Card>
        ) : data ? (
          <Card>
            <CardHeader
              title={data.notes.title || data.name || "Shared API access"}
              subtitle={data.notes.subtitle ?? `${data.keyPrefix ?? "API"} · share key`}
              icon={<ShieldCheck size={16} />}
            />
            <CardBody>
              {data.notes.body ? <p className="share-notes">{data.notes.body}</p> : null}

              {/* Endpoint on the left, the single action on the right. */}
              <div className="share-endpoint">
                <div className="share-endpoint-field">
                  <span className="share-endpoint-label">Base URL</span>
                  <code>{baseUrl}/v1</code>
                  <ClipboardButton
                    value={`${baseUrl}/v1`}
                    size="sm"
                    variant="secondary"
                    label="Copy"
                    copiedLabel="Copied"
                  />
                </div>
                {canIssue ? (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={issueBusy}
                    disabled={issueBusy}
                    onClick={() => void issue()}
                  >
                    {issueBusy ? "Generating…" : "Generate API Key"}
                  </Button>
                ) : null}
              </div>

              {visibleSecret ? (
                <div className="share-issued-secret" role="status">
                  <p className="share-eyebrow">GENERATED ONCE · COPY AND KEEP IT</p>
                  <h2>Your API key</h2>
                  <code>{visibleSecret.key}</code>
                  <div className="share-secret-actions">
                    <ClipboardButton
                      value={visibleSecret.key}
                      size="sm"
                      variant="primary"
                      label="Copy key"
                      copiedLabel="Copied"
                    />
                    <span>Key ID {visibleSecret.keyId.slice(0, 12)}…</span>
                  </div>
                  <p>
                    Saved in this browser while this enrollment link remains valid. It is not
                    shown again from another browser, and an expired, revoked, or unavailable
                    link does not restore a local copy.
                  </p>
                  {storageWarning ? (
                    <p role="alert" className="form-error">{storageWarning}</p>
                  ) : null}
                </div>
              ) : null}

              {!canIssue && !visibleSecret ? (
                <p role="status" className="share-warning">
                  {data.alreadyIssued || issueConflict
                    ? "An active key has already been issued from this IP."
                    : issueError ?? "This enrollment link is not currently accepting key requests."}
                </p>
              ) : null}
              {issueError && canIssue ? (
                <p role="alert" className="form-error">{issueError}</p>
              ) : null}

              <dl className="share-policy">
                <div><dt>Requests / minute</dt><dd>{fmt(data.requestsPerMinute)}</dd></div>
                <div><dt>Concurrent requests</dt><dd>{fmt(data.maxConcurrentRequests)}</dd></div>
                <div><dt>Daily token cap</dt><dd>{fmt(data.dailyLimit)}</dd></div>
                <div><dt>Monthly token cap</dt><dd>{fmt(data.monthlyLimit)}</dd></div>
                <div><dt>Lifetime cap</dt><dd>{fmt(data.oneTimeLimit)}</dd></div>
                <div>
                  <dt>Providers</dt>
                  <dd>{data.providerAllowlist?.length ? data.providerAllowlist.join(", ") : "All allowed"}</dd>
                </div>
              </dl>
              <p className="share-model-policy">
                {data.modelAllowlist.length
                  ? `Allowed models: ${data.modelAllowlist.join(", ")}`
                  : "Model access follows the share template policy."}
                {data.modelDenylist?.length ? ` · Excluded: ${data.modelDenylist.join(", ")}` : ""}
              </p>
              {data.modelPrefix ? (
                <p className="share-model-policy">Required model prefix: {data.modelPrefix}</p>
              ) : null}
              {data.expiresAt ? (
                <p className="share-expiry">
                  Enrollment link expires {new Date(data.expiresAt).toLocaleString()}
                </p>
              ) : null}
              <p className="share-trust-copy">
                This page never displays a parent credential. One active key per canonical IP;
                the browser copy is restored only while this link stays valid.
              </p>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody>
              <EmptyState
                title="No enrollment data"
                message="This enrollment link did not return usable policy data."
              />
            </CardBody>
          </Card>
        )}
      </main>
    </div>
  );
}
