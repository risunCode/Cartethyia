import { useEffect, useState, type ReactElement } from "react";
import { Home, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardBody } from "../../components/ui/card";
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
  const canIssue = Boolean(data?.canIssue) && !data?.alreadyIssued && !issueConflict && !visibleSecret;
  let statusLabel = "Enrollment unavailable";
  let statusClass = "share-status-closed";
  if (visibleSecret) {
    statusLabel = "Key ready";
    statusClass = "share-status-ready";
  } else if (canIssue) {
    statusLabel = "Ready to enroll";
    statusClass = "share-status-open";
  } else if (data?.alreadyIssued || issueConflict) {
    statusLabel = "Already enrolled";
  }
  const modelGroups = new Map<string, string[]>();
  for (const model of data?.modelAllowlist ?? []) {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "Other";
    const models = modelGroups.get(provider) ?? [];
    models.push(model);
    modelGroups.set(provider, models);
  }
  return (
    <div className="share-page">
      <header className="share-topbar">
        <div className="share-topbar-inner">
          <a className="share-brand" href="/">
            <span className="share-brand-mark" aria-hidden="true">
              <ShieldCheck size={17} />
            </span>
            <b>Cartethyia</b>
          </a>
          <a href="/" className="share-home-link">
            <Home size={13} aria-hidden="true" /> Home
          </a>
        </div>
      </header>
      <main className="share-main">
        {state.loading ? (
          <Card className="share-hud-card">
            <CardBody>
              <LoadingState label="Loading enrollment policy…" />
            </CardBody>
          </Card>
        ) : state.error ? (
          <Card className="share-hud-card">
            <CardBody>
              <ErrorState
                title="Link not available"
                message={state.error}
                onRetry={() => window.location.reload()}
              />
            </CardBody>
          </Card>
        ) : data ? (
          <>
            <Card className="share-hud-card share-hero">
              <p className="share-eyebrow">SHARED ACCESS / ENROLLMENT</p>
              <h1>{data.name || "Shared API access"}</h1>
              <p className="share-hero-description">
                A personal API key for this gateway, subject to the limits below.
              </p>
              <div className="share-hero-meta">
                <span className={`share-status ${statusClass}`}>
                  <span className="share-status-dot" aria-hidden="true" />
                  {statusLabel}
                </span>
                {data.keyPrefix ? <span className="share-meta-pill">Prefix {data.keyPrefix}</span> : null}
                {data.expiresAt ? (
                  <span className="share-meta-pill">
                    Link expires {new Date(data.expiresAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
            </Card>

            <Card className="share-hud-card">
              <div className="share-section-heading">
                <h2>Policy &amp; limits</h2>
                <span className="share-section-caption">Your enrollment terms</span>
              </div>
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
            </Card>

            <div className="share-credentials">
              <Card className="share-hud-card share-endpoint">
                <h2 className="share-eyebrow">BASE URL</h2>
                <div className="share-endpoint-field">
                  <code>{baseUrl}/v1</code>
                  <ClipboardButton
                    value={`${baseUrl}/v1`}
                    size="sm"
                    variant="secondary"
                    label="Copy URL"
                    copiedLabel="Copied"
                    aria-label="Copy Base URL"
                  />
                </div>
                <p>Use this endpoint in your API client.</p>
              </Card>
              <Card className="share-hud-card share-key-panel">
                <h2 className="share-eyebrow">YOUR API KEY</h2>
                {visibleSecret ? (
                  <div className="share-issued-secret" role="status">
                    <p className="share-once-notice">GENERATED ONCE · COPY AND KEEP IT</p>
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
                  </div>
                ) : (
                  <>
                    <p className="share-key-placeholder">
                      {canIssue
                        ? "Issue a personal key to use the shared endpoint."
                        : "No key is available in this browser."}
                    </p>
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
                  </>
                )}
                {!canIssue && !visibleSecret ? (
                  <p role="status" className="share-warning">
                    {data.alreadyIssued || issueConflict
                      ? "An active key has already been issued from this IP."
                      : issueError ?? "This enrollment link is not currently accepting key requests."}
                  </p>
                ) : null}
                {issueError && canIssue ? <p role="alert" className="form-error">{issueError}</p> : null}
                {storageWarning ? <p role="alert" className="form-error">{storageWarning}</p> : null}
              </Card>
            </div>

            {data.notes.title || data.notes.subtitle || data.notes.body ? (
              <Card className="share-hud-card share-notes">
                <h2 className="share-eyebrow">NOTES</h2>
                {data.notes.title ? <h3>{data.notes.title}</h3> : null}
                {data.notes.subtitle ? <p className="share-notes-subtitle">{data.notes.subtitle}</p> : null}
                {data.notes.body ? <p className="share-notes-body">{data.notes.body}</p> : null}
              </Card>
            ) : null}

            <Card className="share-hud-card share-models">
              <div className="share-section-heading">
                <div>
                  <p className="share-eyebrow">MODEL ACCESS</p>
                  <h2>Allowed models</h2>
                </div>
                {data.modelAllowlist.length ? (
                  <ClipboardButton
                    value={data.modelAllowlist.join(", ")}
                    size="sm"
                    variant="secondary"
                    label="Copy all"
                    copiedLabel="Copied"
                    aria-label="Copy all allowed models"
                  />
                ) : null}
              </div>
              {modelGroups.size ? (
                <div className="share-model-groups">
                  {[...modelGroups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, models]) => (
                    <section className="share-model-group" key={provider} aria-label={`${provider} models`}>
                      <div className="share-model-group-heading">
                        <h3>{provider}</h3>
                        <span>{models.length}</span>
                      </div>
                      <ul className="share-model-list">
                        {models.map((model) => (
                          <li key={model}>
                            <code title={model}>{provider === "Other" ? model : model.slice(provider.length + 1)}</code>
                            <ClipboardButton
                              value={model}
                              size="sm"
                              variant="secondary"
                              label="Copy"
                              copiedLabel="Copied"
                              aria-label={`Copy ${model}`}
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="share-model-empty">Model access follows the share template policy.</p>
              )}
              {data.modelDenylist?.length ? (
                <p className="share-model-policy">Excluded models: {data.modelDenylist.join(", ")}</p>
              ) : null}
              {data.modelPrefix ? (
                <p className="share-model-policy">Required model prefix: {data.modelPrefix}</p>
              ) : null}
            </Card>
            <p className="share-trust-copy">
              This page never displays a parent credential. One active key per canonical IP;
              the browser copy is restored only while this link stays valid.
            </p>
          </>
        ) : (
          <Card className="share-hud-card">
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
