import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { Check, Clipboard, Home, Sparkles, WandSparkles } from "lucide-react";
import { copyToClipboard } from "../../lib/helpers";
import { useShareData, type ShareEnrollmentData } from "../../lib/hooks/share-data";

type ThemeId = "cyberpunk" | "hacker" | "aurora" | "sakura" | "ember" | "mono";
const themes: ReadonlyArray<{ id: ThemeId; label: string; accent: string; accent2: string; background: string; panel: string; grid: string }> = [
  { id: "cyberpunk", label: "Cyberpunk", accent: "#67e8f9", accent2: "#a78bfa", background: "#050a18", panel: "rgba(9,18,42,.72)", grid: "rgba(103,232,249,.16)" },
  { id: "hacker", label: "Hacker", accent: "#4ade80", accent2: "#bef264", background: "#030b08", panel: "rgba(5,24,17,.78)", grid: "rgba(74,222,128,.15)" },
  { id: "aurora", label: "Aurora", accent: "#5eead4", accent2: "#c4b5fd", background: "#07131a", panel: "rgba(11,31,39,.74)", grid: "rgba(94,234,212,.16)" },
  { id: "sakura", label: "Sakura", accent: "#f9a8d4", accent2: "#c4b5fd", background: "#160b18", panel: "rgba(42,17,43,.72)", grid: "rgba(249,168,212,.15)" },
  { id: "ember", label: "Ember", accent: "#fb923c", accent2: "#facc15", background: "#160b06", panel: "rgba(48,22,11,.76)", grid: "rgba(251,146,60,.15)" },
  { id: "mono", label: "Mono", accent: "#f8fafc", accent2: "#94a3b8", background: "#090b10", panel: "rgba(24,28,38,.78)", grid: "rgba(248,250,252,.12)" },
];
const THEME_KEY = "cartethyia-share-theme";
const ASSET_BASE_URL = import.meta.env.BASE_URL || "/";
interface IssueResult { key: string; keyId: string; keyPrefix: string; createdAt: string }
interface ApiError { error?: string | { code?: string; message?: string }; message?: string }
function initialTheme(): ThemeId {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return themes.some((theme) => theme.id === saved) ? saved as ThemeId : "cyberpunk";
  } catch { return "cyberpunk"; }
}
function themeStyle(theme: (typeof themes)[number]): CSSProperties {
  return { "--share-accent": theme.accent, "--share-accent-2": theme.accent2, "--share-background": theme.background, "--share-panel": theme.panel, "--share-grid": theme.grid } as CSSProperties;
}
function message(payload: ApiError): string {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? payload.message ?? "Unable to generate a child key.";
}
function fmt(value: number | null): string { return value === null ? "Unlimited" : value.toLocaleString(); }

export function SharePage(): ReactElement {
  const path = typeof window === "undefined" ? "/share" : window.location.pathname.replace(/\/$/, "");
  const dataPath = `${path}/data`;
  const issuePath = `${path}/issue`;
  const state = useShareData<ShareEnrollmentData>(dataPath);
  const [themeId, setThemeId] = useState<ThemeId>(initialTheme);
  const [secret, setSecret] = useState<IssueResult | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueConflict, setIssueConflict] = useState(false);
  const [copied, setCopied] = useState(false);
  const theme = themes.find((item) => item.id === themeId) ?? themes[0]!;
  useEffect(() => { document.title = "Cartethyia — Shared access"; }, []);
  useEffect(() => { try { window.localStorage.setItem(THEME_KEY, themeId); } catch { /* Theme selection is non-sensitive. */ } }, [themeId]);
  const issue = async () => {
    setIssueBusy(true);
    setIssueError(null);
    try {
      const response = await fetch(issuePath, { method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: "{}" });
      const payload = await response.json() as IssueResult | ApiError;
      if (!response.ok) {
        if (response.status === 409) setIssueConflict(true);
        setIssueError(response.status === 409 ? "A recipient from this IP already has an active child key for a share. This link cannot issue another key." : message(payload as ApiError));
        return;
      }
      setSecret(payload as IssueResult);
    } catch {
      setIssueError("Unable to reach the Cartethyia gateway. Please try again.");
    } finally { setIssueBusy(false); }
  };
  const copySecret = async () => {
    if (!secret) return;
    setCopied(await copyToClipboard(secret.key));
  };
  const data = state.data;
  return <div className="share-page" data-share-theme={theme.id} style={themeStyle(theme)}>
    <div className="share-enrollment-backdrop" aria-hidden="true"><img src={`${ASSET_BASE_URL}when_yah/cartethyia-god.webp`} alt="" /><span /></div>
    <header className="share-enrollment-header">
      <a className="share-brand" href="/"><span><Sparkles size={15} /></span><b>Cartethyia</b></a>
      <div className="share-header-actions">
        <label className="share-theme-label">Theme <select aria-label="Share page theme" value={themeId} onChange={(event) => setThemeId(event.target.value as ThemeId)}>{themes.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <a href="/" className="share-home-link"><Home size={12} aria-hidden="true" /> Home</a>
      </div>
    </header>
    <main className="share-enrollment-main">
      {state.loading ? <section className="share-enrollment-panel" aria-busy="true"><div className="share-skeleton" /><div className="share-skeleton share-skeleton--short" /></section> : state.error ? <section className="share-enrollment-panel" role="alert"><p className="share-eyebrow">Enrollment unavailable</p><h1>Link not available</h1><p>{state.error}</p><button type="button" className="share-action-secondary" onClick={() => window.location.reload()}>Retry</button></section> : data ? <>
        <section className="share-enrollment-panel share-enrollment-intro">
          <p className="share-eyebrow"><WandSparkles size={13} /> SECURE KEY ENROLLMENT</p>
          <h1>{data.notes.title || data.name || "Shared API access"}</h1>
          {data.notes.subtitle && <p className="share-subtitle">{data.notes.subtitle}</p>}
          {data.notes.body && <p className="share-notes">{data.notes.body}</p>}
          <p className="share-trust-copy">This page never displays a parent credential. Generate your own child key manually; it will be shown once in this page only.</p>
          {data.expiresAt && <p className="share-expiry">Enrollment link expires {new Date(data.expiresAt).toLocaleString()}</p>}
        </section>
        <section className="share-enrollment-panel">
          <div className="share-policy-heading"><div><p className="share-eyebrow">ACCESS POLICY</p><h2>What this key can do</h2></div><span className="share-key-prefix">{data.keyPrefix ?? "API"} · child key</span></div>
          <div className="share-policy-grid"><div><span>Requests / minute</span><strong>{fmt(data.requestsPerMinute)}</strong></div><div><span>Concurrent requests</span><strong>{fmt(data.maxConcurrentRequests)}</strong></div><div><span>Daily token cap</span><strong>{fmt(data.dailyLimit)}</strong></div><div><span>Monthly token cap</span><strong>{fmt(data.monthlyLimit)}</strong></div><div><span>Lifetime cap</span><strong>{fmt(data.oneTimeLimit)}</strong></div><div><span>Providers</span><strong>{data.providerAllowlist?.length ? data.providerAllowlist.join(", ") : "All allowed"}</strong></div></div>
          <p className="share-model-policy">{data.modelAllowlist.length ? `Allowed models: ${data.modelAllowlist.join(", ")}` : "Model access follows the share template policy."}{data.modelDenylist?.length ? ` · Excluded: ${data.modelDenylist.join(", ")}` : ""}</p>
          {data.modelPrefix && <p className="share-model-policy">Required model prefix: {data.modelPrefix}</p>}
          {secret ? (
            <div className="share-issued-secret" role="status">
              <p className="share-eyebrow">GENERATED ONCE · SAVE IT NOW</p>
              <h2>Your child API key</h2>
              <code>{secret.key}</code>
              <div className="share-secret-actions">
                <button type="button" className="share-action-primary" onClick={() => void copySecret()}>
                  {copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? "Copied" : "Copy key"}
                </button>
                <span>Key ID {secret.keyId.slice(0, 12)}…</span>
              </div>
              <p>This credential will not be shown again after leaving or reloading this page.</p>
            </div>
          ) : (
            <div className="share-issue-controls">
              {data.alreadyIssued || issueConflict
                ? <p role="status" className="share-warning">An active child key has already been issued from this IP.</p>
                : issueError && <p role="alert" className="share-warning">{issueError}</p>}
              {!data.canIssue && !data.alreadyIssued && !issueConflict && <p role="status" className="share-warning">This enrollment link is not currently accepting key requests.</p>}
              <button type="button" className="share-action-primary" disabled={!data.canIssue || data.alreadyIssued || issueConflict || issueBusy} onClick={() => void issue()}>
                {issueBusy ? "Generating…" : data.canIssue && !data.alreadyIssued && !issueConflict ? "Generate my child key" : "Enrollment unavailable"}
              </button>
              <p>One active child key per canonical IP. Your secret exists only in this page state and is never saved to browser storage.</p>
            </div>
          )}
        </section>
      </> : <section className="share-enrollment-panel"><h1>No enrollment data</h1></section>}
      <footer className="share-enrollment-footer">Cartethyia · share-key enrollment</footer>
    </main>
  </div>;
}
