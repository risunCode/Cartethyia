import { useEffect, useRef, useState, type ReactElement } from "react";
import { Bot, Brain, CheckCircle2, Eye, FlaskConical, Globe, Home, Moon, Sun, Wrench, X } from "lucide-react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { Button } from "../../components/ui/button";
import { Card, CardBody } from "../../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { downloadTextFile } from "../../lib/download";
import { GithubBadge } from "../../components/patterns/github-badge";
import { toast } from "../../lib/toast";
import { formatModelTokens, UNKNOWN_LIMITS_TOOLTIP } from "../../lib/model-limits";
import { formatProbeDuration } from "../../lib/format";
import { readConsoleTheme, applyConsoleTheme, isDarkEffective, writeConsoleTheme, type ConsoleThemeChoice } from "../../lib/theme";
import { useShareData, type ShareLinkData, type ShareModelInfoData } from "../../hooks/share-data";
import {
  LiveShareQuotaPanel,
  LiveShareStatsSection,
  ShareStatsProvider,
} from "./stats";
import {
  deleteStoredShareKey,
  readStoredShareKey,
  writeStoredShareKey,
  type StoredShareKey,
} from "../../apps/share/share-key-storage";

interface IssueResult { key: string; keyId: string; keyPrefix: string; createdAt: string }
interface ApiError { error?: string | { code?: string; message?: string }; message?: string }
type ProbeResult =
  | { readonly ok: true; readonly ttftMs: number; readonly totalMs: number }
  | { readonly ok: false; readonly status: number | null };

function message(payload: ApiError): string {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? payload.message ?? "Unable to generate an API key.";
}

export function tokenFromPathname(pathname: string): string {
  const path = pathname.replace(/\/$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Hint the recipient types: capped at 20 chars, only ~7 survive the label. */
const NAME_HINT_MAX_LENGTH = 20;

/**
 * One allowed model, drawn like the provider catalog's model cards.
 *
 * The share page shows the same shape an operator sees in provider detail, so
 * the two read as the same thing: an icon tile, the routable id with an
 * icon-only copy button, then a quiet line of capabilities and limits — the
 * limits formatted by the same `formatModelTokens` the catalog card uses. Copy and
 * Test are offered when a share key is available; admin actions such as disable
 * or delete are never exposed.
 *
 * The context window and output cap come from the catalog row the gateway
 * already serves `/v1/models` from; a name with no row reports the limit as
 * unavailable rather than an invented number.
 */
function ModelCard({
  id,
  label,
  info,
  canProbe,
  probing,
  onProbe,
  result,
}: {
  /** The id as a client must send it. */
  readonly id: string;
  /** What the card shows; the bare id in the grouped reading. */
  readonly label: string;
  readonly info: ShareModelInfoData | undefined;
  readonly canProbe: boolean;
  readonly probing: boolean;
  readonly onProbe: (model: string) => void;
  readonly result: ProbeResult | undefined;
}): ReactElement {
  const vision = (info?.capabilities?.input ?? []).some(
    (modality) => modality === "image" || modality === "vision",
  );
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-control border border-inner-border bg-surface-2 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="inline-flex size-13 shrink-0 items-center justify-center rounded-lg bg-teal-soft text-teal" aria-hidden="true">
          <Bot size={14} />
        </span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-caption font-semibold leading-[1.35] text-text-primary" title={id}>
          {label}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-text-secondary text-badge">
        <span className="inline-flex gap-1 [&>span]:inline-flex">
          {info?.reasoning ? (
            <span title="Reasoning" aria-label="Reasoning" className="text-purple">
              <Brain size={12} />
            </span>
          ) : null}
          {vision ? (
            <span title="Vision" aria-label="Vision" className="text-status-info">
              <Eye size={12} />
            </span>
          ) : null}
          {info?.toolCall ? (
            <span title="Tool calling" aria-label="Tool calling" className="text-orange">
              <Wrench size={12} />
            </span>
          ) : null}
          {info?.webSearch ? (
            <span title="Web search" aria-label="Web search" className="text-teal">
              <Globe size={12} />
            </span>
          ) : null}
        </span>
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {info?.contextLength != null ? (
            `${formatModelTokens(info.contextLength)} ctx`
          ) : (
            <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
              n/a ctx
            </span>
          )}
          {" · "}
          {info?.maxOutputTokens != null ? (
            `${formatModelTokens(info.maxOutputTokens)} out`
          ) : (
            <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
              n/a out
            </span>
          )}
        </span>
      </div>
      {result?.ok ? (
        <div className="flex flex-wrap items-center gap-4 font-mono text-badge text-text-secondary [&>strong]:font-sans [&>strong]:text-green" role="status">
          <strong>OK</strong>
          <span>TTFT {formatProbeDuration(result.ttftMs)}</span>
          <span>Done {formatProbeDuration(result.totalMs)}</span>
        </div>
      ) : null}
      <div className="mt-auto grid min-w-0 grid-cols-2 items-center gap-4 [&>*]:w-full [&>*]:min-w-0 [&_.btn]:w-full [&_.btn]:min-w-0">
        {canProbe ? (
          <Button
            variant="secondary"
            size="sm"
            icon={
              result?.ok ? (
                <span className="inline-flex text-green">
                  <CheckCircle2 size={13} />
                </span>
              ) : (
                <FlaskConical size={13} />
              )
            }
            loading={probing}
            disabled={probing}
            onClick={() => onProbe(id)}
            title={
              result?.ok
                ? `Last test passed in ${formatProbeDuration(result.totalMs)} — click to re-test`
                : result
                  ? `Last test failed${result.status !== null ? ` with HTTP ${result.status}` : ""} — click to re-test`
                  : "Test this model using the shared API key"
            }
          >
            {probing
              ? "Testing…"
              : result?.ok
                ? `Done ${formatProbeDuration(result.totalMs)}`
                : result
                  ? `Failed${result.status !== null ? ` ${result.status}` : ""}`
                  : "Test"}
          </Button>
        ) : null}
        <ClipboardButton
          value={id}
          size="sm"
          variant="secondary"
          label="Copy"
          copiedLabel="Copied"
          aria-label={`Copy ${id}`}
          title={`Copy ${id}`}
        />
      </div>
    </div>
  );
}

export function SharePage(): ReactElement {
  const path = typeof window === "undefined" ? "/share" : window.location.pathname.replace(/\/$/, "");
  const dataPath = `${path}/data`;
  const issuePath = `${path}/issue`;
  const linkToken = typeof window === "undefined" ? "" : tokenFromPathname(path);
  // The gateway cannot know the origin a share page is reached by — a tunnel, a
  // reverse proxy, or the operator's own public origin can all differ from the
  // request's view. The browser is the only party that knows for certain, so
  // the endpoint the recipient is told to call is derived here.
  const baseUrl = typeof window === "undefined" ? "" : window.location.origin;
  const state = useShareData<ShareLinkData>(dataPath);
  // Family activity lives behind ShareStatsProvider (see ./stats): the page
  // itself does not subscribe, so a stream tick cannot re-render it.
  const [secret, setSecret] = useState<IssueResult | null>(null);
  const [restoredSecret, setRestoredSecret] = useState<StoredShareKey | null>(null);
  // The recipient's display-name hint for the issued key. The backend keeps
  // only the first ~7 chars and appends its own random suffix, so a short
  // hint survives verbatim and a long one is trimmed, never rejected.
  const [nameHint, setNameHint] = useState("");
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [probingModels, setProbingModels] = useState<ReadonlySet<string>>(() => new Set());
  const [probeResults, setProbeResults] = useState<ReadonlyMap<string, ProbeResult>>(() => new Map());
  const probeAbortRef = useRef<Map<string, AbortController>>(new Map());
  const [issueConflict, setIssueConflict] = useState(false);
  const [sharePopupOpen, setSharePopupOpen] = useState(false);
  const sharePopupRef = useRef<HTMLElement>(null);
  const apiKeyPanelRef = useRef<HTMLDivElement>(null);
  useModalFocus({ open: sharePopupOpen, mounted: sharePopupOpen, panelRef: sharePopupRef, onClose: () => setSharePopupOpen(false) });
  // Dark is the default reading of the share HUD; the toggle beside Home flips
  // the same `console-theme` preference the console uses.
  const [theme, setTheme] = useState<ConsoleThemeChoice>(() => readConsoleTheme("dark"));
  // The allowed-model list has two readings: the flat allowlist as written
  // ("raw") and the same set bucketed by provider ("grouped"). Raw is the
  // default because the exact id is what a client has to send.
  const [modelView, setModelView] = useState<"raw" | "grouped">("raw");
  useEffect(() => {
    document.title = "Cartethyia — Shared access";
    // The public share surface owns no theme of its own: it applies the console
    // `console-theme` preference through the same helper the console uses, so
    // both apps on this origin always resolve to the same tokens. The bootstrap
    // in `index.html` resolves the same key before the bundle loads, defaulting
    // an unset preference to dark on the share page.
    setTheme(readConsoleTheme("dark"));
    applyConsoleTheme(readConsoleTheme("dark"));
  }, []);
  const enrollment = state.data?.kind === "enroll" ? state.data : null;
  useEffect(() => {
    let active = true;
    setSecret(null);
    setRestoredSecret(null);
    setStorageWarning(null);
    // Only an enrollment link mints a key worth remembering: a handoff link is
    // re-read from the gateway on every visit, so a local copy would only go
    // stale, and an endpoint that rejects the link must not leave one behind.
    if (!linkToken || !enrollment) {
      if (state.error) {
        void deleteStoredShareKey(linkToken).catch(() => undefined);
      }
      return;
    }
    void readStoredShareKey(linkToken)
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
  }, [linkToken, enrollment, state.error]);
  const issue = async () => {
    setIssueBusy(true);
    setIssueError(null);
    setStorageWarning(null);
    try {
      const response = await fetch(issuePath, { method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify(nameHint.trim() ? { nameHint: nameHint.trim().slice(0, NAME_HINT_MAX_LENGTH) } : {}) });
      const payload = await response.json() as IssueResult | ApiError;
      if (!response.ok) {
        if (response.status === 409) setIssueConflict(true);
        setIssueError(response.status === 409 ? "A recipient from this IP already has an active key for a share. This link cannot issue another key." : message(payload as ApiError));
        return;
      }
      const issued = payload as IssueResult;
      setRestoredSecret(null);
      setSecret(issued);
      if (!linkToken) return;
      try {
        await writeStoredShareKey(linkToken, {
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
  const canProbe = data?.kind === "handoff" ? Boolean(data.key) : Boolean(visibleSecret?.key);
  const focusApiKeyPanel = () => {
    const panel = apiKeyPanelRef.current;
    if (!panel) return;
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    panel.focus({ preventScroll: true });
  };
  const probeModel = async (model: string): Promise<void> => {
    const key = data?.kind === "handoff" ? data.key : (restoredSecret ?? secret)?.key;
    if (probingModels.has(model)) return;
    if (!key) {
      toast.error("Create your API key first", "Generate a key in the API key panel before testing a model.");
      focusApiKeyPanel();
      return;
    }
    const controller = new AbortController();
    probeAbortRef.current.set(model, controller);
    setProbingModels((current) => new Set(current).add(model));
    const startedAt = performance.now();
    let firstByteAt: number | null = null;
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          stream: true,
          max_tokens: 16,
        }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        // The card keeps the status: a toast alone disappears, and the button
        // used to revert to "Test", so a 403 looked identical to never tested.
        setProbeResults((current) => new Map(current).set(model, { ok: false, status: response.status }));
        toast.error("Model probe failed", `Request failed with HTTP ${response.status}`);
        return;
      }
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.value && chunk.value.byteLength > 0 && firstByteAt === null) {
            firstByteAt = performance.now();
          }
          if (chunk.done) break;
        }
      } finally {
        reader.releaseLock();
      }
      const totalMs = Math.round(performance.now() - startedAt);
      const ttftMs = Math.round((firstByteAt ?? performance.now()) - startedAt);
      setProbeResults((current) => new Map(current).set(model, { ok: true, ttftMs, totalMs }));
      toast.success("Model test complete", `${model} · TTFT ${ttftMs} ms · Done ${totalMs} ms`);
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setProbeResults((current) => new Map(current).set(model, { ok: false, status: null }));
        toast.error("Model probe failed", error instanceof Error ? error.message : "The request could not be completed.");
      }
    } finally {
      if (probeAbortRef.current.get(model) === controller) probeAbortRef.current.delete(model);
      setProbingModels((current) => {
        const next = new Set(current);
        next.delete(model);
        return next;
      });
    }
  };
  useEffect(() => () => {
    for (const controller of probeAbortRef.current.values()) controller.abort();
  }, []);
  // Only an enrollment link can mint; a handoff link already carries its key.
  const canIssue =
    Boolean(enrollment?.canIssue) && !enrollment?.alreadyIssued && !issueConflict && !visibleSecret;
  const handoffKey = data?.kind === "handoff" ? data.key : null;
  const modelGroups = new Map<string, string[]>();
  for (const model of data?.models ?? []) {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "Other";
    const models = modelGroups.get(provider) ?? [];
    models.push(model);
    modelGroups.set(provider, models);
  }
  return (
    <ShareStatsProvider path={`${path}/stats/stream`}>
      <div className="min-h-screen text-text-primary font-sans">
      <header className="backdrop-blur-md backdrop-saturate-150 border-b border-glass-border-2 bg-glass-bg">
        <div className="mx-auto flex min-h-33 w-full max-w-480 items-center justify-between gap-8 px-12 py-6 max-narrow:min-h-29 max-narrow:gap-5 max-narrow:px-7 max-narrow:py-5">
          <a className="inline-flex items-center gap-5 font-head text-lead tracking-[-0.03em] text-text-primary no-underline" href="/">
            <span className="grid size-17 place-items-center overflow-hidden rounded-control border border-inner-border bg-accent-soft text-accent" aria-hidden="true">
              <img
                className="block size-full object-cover"
                src={`${import.meta.env.BASE_URL}assets/brand/favicon.jpg`}
                alt=""
                width={34}
                height={34}
              />
            </span>
            <b>Cartethyia</b>
          </a>
          <div className="inline-flex items-center gap-4 max-narrow:gap-3">
            <GithubBadge className="max-narrow:min-w-17 max-narrow:justify-center max-narrow:px-0 max-narrow:[&_.github-badge-metric]:hidden" />
            <button
              type="button"
              className="grid size-17 cursor-pointer place-items-center rounded-pill border border-inner-border bg-surface-2 text-text-secondary hover:border-border-strong hover:text-text-primary focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2"
              onClick={() => {
                const next: ConsoleThemeChoice = isDarkEffective(theme) ? "light" : "dark";
                setTheme(next);
                writeConsoleTheme(next);
              }}
              aria-label="Toggle theme"
              aria-pressed={isDarkEffective(theme)}
              title={isDarkEffective(theme) ? "Switch to light mode" : "Switch to dark mode"}
            >
              {isDarkEffective(theme) ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <a href="/" className="inline-flex min-h-17 items-center gap-3 rounded-pill border border-inner-border bg-surface-2 px-6 text-badge font-semibold text-text-secondary no-underline hover:border-border-strong hover:text-text-primary max-narrow:px-5">
              <Home size={13} aria-hidden="true" /> Home
            </a>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-480 flex-col gap-8 px-12 pb-24 pt-14 max-narrow:gap-6 max-narrow:px-6 max-narrow:pb-16 max-narrow:pt-9">
        {state.loading ? (
          <Card surface="muted" className="min-w-0 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-5">
            <CardBody>
              <LoadingState label="Loading enrollment policy…" />
            </CardBody>
          </Card>
        ) : state.error ? (
          <Card surface="muted" className="min-w-0 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-5">
            <CardBody>
              <ErrorState
                title={state.code === "link_disabled" ? "Key paused" : "Link not available"}
                message={state.error}
                onRetry={() => window.location.reload()}
              />
            </CardBody>
          </Card>
        ) : data ? (
          <>
            <Card surface="muted" className="min-w-0 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-7 max-sm:p-5">
              <p className="text-text-secondary font-mono text-micro font-bold tracking-label leading-normal">
                {data.kind === "handoff" ? "SHARED ACCESS / KEY" : "SHARED ACCESS / ENROLLMENT"}
              </p>
              <h1>{data.name || "Shared API access"}</h1>
              {data.kind === "handoff" ? (
                <p className="mt-2.5 text-text-secondary text-body leading-[1.55]">
                  The API key for this gateway, provided through a share link. It is subject to the
                  limits below.
                </p>
              ) : null}
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {data.expiresAt ? (
                  <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-inner-border bg-surface-2 px-2.5 py-1 text-text-secondary font-mono text-micro leading-[1.3]">
                    Link expires {new Date(data.expiresAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
              <LiveShareQuotaPanel policy={data} />
            </Card>

            <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1">
              <Card surface="muted" className="flex min-w-0 flex-col items-start gap-6 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-5">
                <h2 className="text-text-secondary font-mono text-micro font-bold tracking-label leading-normal">BASE URL</h2>
                <div className="flex w-full min-w-0 items-center gap-4 [&>code]:block [&>code]:min-w-0 [&>code]:flex-1 [&>code]:overflow-hidden [&>code]:text-ellipsis [&>code]:whitespace-nowrap [&>code]:rounded-inset [&>code]:border [&>code]:border-inner-border [&>code]:bg-code-surface [&>code]:p-5 [&>code]:text-text-primary [&>code]:font-mono [&>code]:text-caption [&>code]:leading-normal [&>button]:shrink-0">
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
                <p className="text-caption leading-[1.55] text-text-secondary">Point your SDK, Opencode, Claude Code, Droid, and any other CLI</p>
                {data.sharePopup.enabled ? (
                  <button
                    type="button"
                    className="flex w-full min-w-0 cursor-pointer items-center gap-6 rounded-panel border border-orange/30 bg-gradient-to-br from-orange-soft to-surface-2 p-6 text-left text-text-primary transition-transform duration-150 ease-spring hover:-translate-y-px hover:border-orange"
                    onClick={() => setSharePopupOpen(true)}
                    aria-haspopup="dialog"
                    aria-label="Open popup"
                  >
                    <span className="grid size-19 flex-none place-items-center rounded-control bg-orange-soft text-title text-orange" aria-hidden="true">♡</span>
                    <span className="grid min-w-0 gap-1.5">
                      <strong className="text-caption">{data.sharePopup.title || "More information"}</strong>
                    </span>
                    <span className="ml-auto text-lead text-orange" aria-hidden="true">↗</span>
                  </button>
                ) : null}
              </Card>
              <div ref={apiKeyPanelRef} tabIndex={-1}>
              <Card surface="muted" className="flex min-w-0 flex-col items-start gap-6 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-5">
                <h2 className="text-text-secondary font-mono text-micro font-bold tracking-label leading-normal">YOUR API KEY</h2>
                {data.kind === "handoff" ? (
                  handoffKey ? (
                    <div className="flex w-full min-w-0 flex-col gap-5" role="status">
                      <p className="font-mono text-micro font-bold tracking-label text-orange">REVEALED BY THE LINK OWNER</p>
                      <code className="block min-w-0 flex-1 overflow-hidden rounded-inset border border-inner-border bg-code-surface p-5 font-mono text-caption leading-normal text-text-primary [overflow-wrap:anywhere] [user-select:all]">{handoffKey}</code>
                      <div className="flex flex-wrap items-center gap-5 [&>span]:font-mono [&>span]:text-micro [&>span]:text-text-tertiary">
                        <ClipboardButton
                          value={handoffKey}
                          size="sm"
                          variant="primary"
                          label="Copy key"
                          copiedLabel="Copied"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            downloadTextFile(
                              "cartethyia-api-key.txt",
                              `Cartethyia API key\n\n${handoffKey}\n\nKeep this secret.\n`,
                              "text/plain;charset=utf-8",
                            )
                          }
                        >
                          Save this key
                        </Button>
                        <span>Prefix {data.keyPrefix ?? "—"}</span>
                      </div>
                      <p className="text-caption leading-[1.55] text-text-secondary">
                        This link reveals the key itself, so anyone holding the URL can read it.
                        Keep the URL private; the link owner regenerates it to replace this key.
                      </p>
                    </div>
                  ) : (
                    <p className="text-caption leading-normal text-text-secondary">
                      This link can no longer reveal its key. Ask the link owner to regenerate it.
                    </p>
                  )
                ) : visibleSecret ? (
                  <div className="flex w-full min-w-0 flex-col gap-5" role="status">
                    <p className="font-mono text-micro font-bold tracking-[0.06em] text-orange">GENERATED ONCE · COPY AND KEEP IT</p>
                    <code className="block min-w-0 flex-1 overflow-hidden rounded-inset border border-inner-border bg-code-surface p-5 font-mono text-caption leading-normal text-text-primary [overflow-wrap:anywhere] [user-select:all]">{visibleSecret.key}</code>
                    <div className="flex flex-wrap items-center gap-5 [&>span]:font-mono [&>span]:text-micro [&>span]:text-text-tertiary">
                      <ClipboardButton
                        value={visibleSecret.key}
                        size="sm"
                        variant="primary"
                        label="Copy key"
                        copiedLabel="Copied"
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          downloadTextFile(
                            "cartethyia-api-key.txt",
                            `Cartethyia API key\n\n${visibleSecret.key}\n\nKeep this secret.\n`,
                            "text/plain;charset=utf-8",
                          )
                        }
                      >
                        Save this key
                      </Button>
                      <span>Key ID {visibleSecret.keyId.slice(0, 12)}…</span>
                    </div>
                    <p className="text-caption leading-[1.55] text-text-secondary">
                      Saved in this browser while this enrollment link remains valid. It is not
                      shown again from another browser, and an expired, revoked, or unavailable
                      link does not restore a local copy.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-caption leading-normal text-text-secondary">
                      {canIssue
                        ? "Issue a personal key to use the shared endpoint."
                        : "No key is available in this browser."}
                    </p>
                    {canIssue ? (
                      <>
                        <label className="flex w-full flex-col gap-1.5 text-text-secondary text-micro font-bold [&>input]:w-full [&>input]:min-h-11 [&>input]:rounded-control [&>input]:border [&>input]:border-inner-border [&>input]:bg-surface-1 [&>input]:px-3 [&>input]:text-text-primary [&>input]:text-body [&>input]:font-medium [&>input]:focus-visible:outline-2 [&>input]:focus-visible:outline-focus-ring [&>input]:focus-visible:outline-offset-2">
                          <span>Your name</span>
                          <input
                            type="text"
                            value={nameHint}
                            required
                            maxLength={NAME_HINT_MAX_LENGTH}
                            autoComplete="nickname"
                            onChange={(event) => setNameHint(event.target.value)}
                          />
                          <span className="text-text-tertiary text-micro font-normal leading-normal">
                            Shown on your key (best kept to ~5 letters) — the gateway appends its own code.
                          </span>
                        </label>
                        <p className="-mt-3 text-text-tertiary text-micro font-normal leading-normal">Enter your name to generate a personal key.</p>
                        <Button
                          variant="primary"
                          size="sm"
                          loading={issueBusy}
                          disabled={issueBusy || !nameHint.trim()}
                          onClick={() => void issue()}
                        >
                          {issueBusy ? "Generating…" : "Generate API Key"}
                        </Button>
                      </>
                    ) : null}
                  </>
                )}
                {data.kind === "enroll" && !canIssue && !visibleSecret ? (
                  <p role="status" className="w-full rounded-inset border border-orange-soft bg-orange-soft px-5 py-4 text-badge leading-normal text-orange">
                    {enrollment?.alreadyIssued || issueConflict
                      ? "An active key has already been issued from this IP."
                      : issueError ?? "This enrollment link is not currently accepting key requests."}
                  </p>
                ) : null}
                {issueError && canIssue ? <p role="alert" className="form-error">{issueError}</p> : null}
                {storageWarning ? <p role="alert" className="form-error">{storageWarning}</p> : null}
              </Card>
              </div>
            </div>

            {sharePopupOpen && data.sharePopup.enabled ? (
              <div
                className="fixed inset-0 z-drawer grid place-items-center overflow-y-auto bg-black/70 p-10 backdrop-blur max-sm:place-items-end max-sm:p-5"
                role="presentation"
                onClick={(event) => {
                  if (event.target === event.currentTarget) setSharePopupOpen(false);
                }}
              >
                <section
                  ref={sharePopupRef}
                  tabIndex={-1}
                  className="relative grid max-h-[min(calc(var(--spacing)*340),calc(100dvh-var(--spacing)*20))] w-full max-w-380 grid-cols-2 overflow-auto rounded-hero border border-glass-border-2 bg-surface-1 shadow-popout max-sm:max-h-[calc(100dvh-var(--spacing)*10)] max-sm:w-full max-sm:max-w-240 max-sm:grid-cols-1 max-sm:rounded-card"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="share-support-title"
                >
                  <button type="button" className="absolute top-6 right-6 z-card grid size-18 place-items-center rounded-pill border border-inner-border bg-surface-1 text-text-secondary focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2" onClick={() => setSharePopupOpen(false)} aria-label="Close popup">
                    <X size={18} aria-hidden="true" />
                  </button>
                  {data.sharePopup.hasImage ? (
                    <img
                      className="h-full min-h-180 w-full object-cover max-sm:h-auto max-sm:max-h-[min(52dvh,calc(var(--spacing)*210))] max-sm:min-h-0 max-sm:object-contain"
                      src={`/share/${linkToken}/popup-image`}
                      alt=""
                    />
                  ) : (
                    <div className="grid h-full min-h-180 w-full place-items-center bg-gradient-to-br from-orange-soft to-surface-2 text-7xl text-orange max-sm:h-[clamp(calc(var(--spacing)*85),34dvh,calc(var(--spacing)*130))] max-sm:min-h-85 max-sm:max-h-130" aria-hidden="true">
                      <span>♡</span>
                    </div>
                  )}
                  <div className="flex flex-col justify-center gap-7 p-[clamp(calc(var(--spacing)*12),5vw,calc(var(--spacing)*22))] max-sm:gap-6 max-sm:p-11">
                    <h2 id="share-support-title" className="pr-10 font-head text-display leading-tight tracking-tight wrap-anywhere">{data.sharePopup.title || "More information"}</h2>
                    {data.sharePopup.body ? (
                      <p id="share-support-message" className="text-body leading-loose whitespace-pre-wrap text-text-secondary wrap-anywhere">
                        {data.sharePopup.body}
                      </p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap items-center gap-5 [&>*]:flex-auto">
                      <button type="button" className="inline-flex min-h-21 items-center justify-center rounded-pill border border-inner-border bg-surface-2 px-8 text-caption font-bold text-text-primary no-underline hover:brightness-110 focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2" onClick={() => setSharePopupOpen(false)}>
                        Close
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            ) : null}
            {data.notes.title || data.notes.subtitle || data.notes.body ? (
              <Card surface="muted" className="min-w-0 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-5">
                <h2 className="text-text-secondary font-mono text-micro font-bold tracking-label leading-normal">NOTES</h2>
                {data.notes.title ? <h3 className="mt-5 font-head text-title font-semibold">{data.notes.title}</h3> : null}
                {data.notes.subtitle ? <p className="mt-3 text-caption font-semibold text-text-secondary">{data.notes.subtitle}</p> : null}
                {data.notes.body ? <p className="mt-5 text-body leading-loose whitespace-pre-wrap text-text-secondary">{data.notes.body}</p> : null}
              </Card>
            ) : null}

            <LiveShareStatsSection />

            <Card surface="muted" className="min-w-0 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-5">
              <div className="flex items-center justify-between gap-6">
                <div>
                  <p className="text-text-secondary font-mono text-micro font-bold tracking-label leading-normal">MODEL ACCESS</p>
                  <h2 className="mt-3 font-head text-lead font-semibold tracking-tight">Allowed models</h2>
                </div>
                <div className="inline-flex items-center gap-4">
                  <div
                    className="inline-flex rounded-pill border border-inner-border bg-surface-2 p-1"
                    role="tablist"
                    aria-label="Allowed model layout"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={modelView === "raw"}
                      className={`min-h-13 cursor-pointer rounded-pill border-0 bg-transparent px-5 font-mono text-micro font-bold tracking-label text-text-secondary uppercase hover:text-text-primary${modelView === "raw" ? " bg-accent text-accent-foreground" : ""}`}
                      onClick={() => setModelView("raw")}
                    >
                      Raw
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={modelView === "grouped"}
                      className={`min-h-13 cursor-pointer rounded-pill border-0 bg-transparent px-5 font-mono text-micro font-bold tracking-label text-text-secondary uppercase hover:text-text-primary${modelView === "grouped" ? " bg-accent text-accent-foreground" : ""}`}
                      onClick={() => setModelView("grouped")}
                    >
                      Grouped
                    </button>
                  </div>
                  {data.models.length ? (
                    <ClipboardButton
                      value={data.models.join(", ")}
                      size="sm"
                      variant="secondary"
                      label="Copy all"
                      copiedLabel="Copied"
                      aria-label="Copy all granted models"
                    />
                  ) : null}
                </div>
              </div>
              {modelGroups.size ? (
                modelView === "raw" ? (
                  <div className="mt-8 grid grid-cols-3 gap-4 max-wide:grid-cols-2 max-narrow:grid-cols-1">
                    {data.models.map((model) => (
                      <ModelCard key={model} id={model} label={model} info={data.modelInfo?.[model]} canProbe={canProbe} probing={probingModels.has(model)} onProbe={probeModel} result={probeResults.get(model)} />
                    ))}
                  </div>
                ) : (
                  <div className="mt-8 grid grid-cols-2 gap-6 min-extra-wide:grid-cols-3 max-medium:grid-cols-1">
                    {[...modelGroups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, models]) => (
                      <section className="min-w-0 overflow-hidden rounded-panel border border-inner-border bg-surface-2" key={provider} aria-label={`${provider} models`}>
                        <div className="flex items-center justify-between gap-6 border-b border-inner-border px-6 py-5">
                          <h3 className="font-mono text-badge font-bold text-text-primary wrap-anywhere">{provider}</h3>
                          <span className="rounded-pill bg-accent-soft px-4 py-1 font-mono text-micro font-bold text-accent">{models.length}</span>
                        </div>
                        <div className="mt-0 grid max-h-150 grid-cols-1 gap-3 overflow-y-auto p-4">
                          {models.map((model) => (
                            <ModelCard
                              key={model}
                              id={model}
                              label={provider === "Other" ? model : model.slice(provider.length + 1)}
                              info={data.modelInfo?.[model]}
                              canProbe={canProbe}
                              probing={probingModels.has(model)}
                              onProbe={probeModel}
                              result={probeResults.get(model)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )
              ) : (
                <p className="mt-8 rounded-control border border-inner-border bg-surface-2 p-7 text-caption text-text-secondary">Model access follows the share template policy.</p>
              )}
              {data.modelPrefix ? (
                <p className="mt-6 text-badge leading-normal text-text-secondary wrap-anywhere">Required model prefix: {data.modelPrefix}</p>
              ) : null}
            </Card>
          </>
        ) : (
          <Card surface="muted" className="min-w-0 border-glass-border-2 bg-glass-bg backdrop-blur-md backdrop-saturate-150 p-5">
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
    </ShareStatsProvider>
  );
}
