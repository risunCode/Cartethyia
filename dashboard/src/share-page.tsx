/* @jsxImportSource solid-js */

import { Activity, ArrowUpRight, Check, Clipboard, GitFork, Home, MessageCircle, Route, ShieldCheck } from "lucide-solid";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import { copyToClipboard } from "./lib/clipboard";
import { useShareData, type ShareMonitorData, type ShareSetupData } from "./composables/browser/use-share-data";
import { resolveShareInFlight, useShareInFlightStream } from "./composables/observability/use-inflight-stream";

const PREVIEW_DATA: ShareMonitorData = {
  name: "The Routing Sanctum", active: true, quotaAvailable: true, inFlight: 3,
  apiKey: { id: "preview", prefix: "crth_preview", active: true },
  totalTokens: 184_250, totalRequests: 1_284,
  dailyUsed: 12_480, dailyLimit: 50_000, dailyRemaining: 37_520,
  monthlyUsed: 184_250, monthlyLimit: 1_000_000, monthlyRemaining: 815_750,
  oneTimeLimit: 250_000, oneTimeUsed: 184_250, oneTimeRemaining: 65_750,
  rateLimitRpm: 120, maxConcurrentRequests: 8,
  providerAllowlist: "anthropic, openai", modelAllowlist: "claude-sonnet, gpt-5", modelDenylist: null,
  notes: { title: "Move with intent.", subtitle: "Shared passage", body: "This is a read-only preview of the gateway monitor." },
  createdAt: new Date(Date.now() - 7 * 86_400_000).toISOString(), lastUsedAt: new Date(Date.now() - 12 * 60_000).toISOString(), baseUrl: "https://gateway.example.com/v1",
};

function formatNumber(value: number | null): string { return value === null ? "Unlimited" : value.toLocaleString(); }
function formatDate(value: string | null): string { if (value === null) return "Never"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function quotaPercent(used: number, limit: number | null): number { if (limit === null || limit <= 0) return 0; return Math.min(100, Math.max(0, (used / limit) * 100)); }

function CopyField(props: { label: string; value: string; copied: boolean; onCopy: (value: string) => void }): JSX.Element {
  return <div class="share-field"><div class="share-field__label"><span>{props.label}</span><button type="button" class="share-copy" onClick={() => props.onCopy(props.value)}>{props.copied ? <Check size={13} /> : <Clipboard size={13} />}{props.copied ? "Copied" : "Copy"}</button></div><code>{props.value}</code></div>;
}

function QuotaBar(props: { label: string; used: number; limit: number | null; remaining: number | null }): JSX.Element {
  const percent = quotaPercent(props.used, props.limit);
  return <div class="share-quota"><div class="share-quota__head"><span>{props.label}</span><strong>{formatNumber(props.remaining)} <small>left</small></strong></div><div class="share-quota__value"><strong>{props.used.toLocaleString()}</strong><span>{props.limit === null ? "No cap" : `${props.limit.toLocaleString()} cap`}</span></div><div class="share-progress" role="progressbar" aria-label={`${props.label} usage`} aria-valuemin={0} aria-valuemax={props.limit ?? 0} aria-valuenow={props.limit === null ? 0 : props.used}><span style={{ width: `${props.limit === null ? 8 : Math.max(3, percent)}%` }} /></div></div>;
}

function DetailList(props: { title: string; icon: JSX.Element; children: JSX.Element }): JSX.Element {
  return <section class="share-detail"><div class="share-detail__title">{props.icon}<span>{props.title}</span></div>{props.children}</section>;
}

export function SharePage(props: { readonly preview?: boolean } = {}): JSX.Element {
  const isSetup = window.location.pathname.startsWith("/share/setup/");
  const dataPath = `${window.location.pathname.replace(/\/$/, "")}/data`;
  const state = useShareData<ShareMonitorData | ShareSetupData>(dataPath, isSetup ? undefined : 15_000, !props.preview);
  const shareToken = !isSetup ? window.location.pathname.match(/^\/share\/([^/]+)/)?.[1] ?? null : null;
  const stream = useShareInFlightStream(shareToken, !props.preview && !isSetup);
  const [copied, setCopied] = createSignal<string | null>(null);
  document.title = "Cartethyia · Shared passage";
  const monitor = (): ShareMonitorData | null => { if (props.preview) return PREVIEW_DATA; const value = state.data(); return !isSetup && value !== null ? value as ShareMonitorData : null; };
  const setup = (): ShareSetupData | null => { const value = state.data(); return isSetup && value !== null ? value as ShareSetupData : null; };
  const liveInFlight = (): number => resolveShareInFlight(stream(), monitor()?.inFlight ?? 0);
  const liveStatus = (): string => { const status = stream().connectionStatus; if (status === "connected") return "Live updates connected"; if (status === "error") return "Live updates reconnecting"; if (status === "connecting") return "Connecting live updates"; return "Live updates unavailable"; };
  const copy = async (value: string): Promise<void> => { if (!await copyToClipboard(value)) return; setCopied(value); window.setTimeout(() => setCopied((current) => current === value ? null : current), 1600); };
  onCleanup(() => setCopied(null));

  if (props.preview) return <div class="share-page" aria-label="Share preview" />;

  return <div class="share-page"><div class="share-page__glow share-page__glow--one" aria-hidden="true" /><div class="share-page__glow share-page__glow--two" aria-hidden="true" /><div class="share-page__shell">
    <header class="share-header"><a class="share-brand" href="/home"><img src="/favicon.webp" alt="" /><span><strong>Cartethyia</strong><small>Shared passage</small></span></a><nav class="share-nav" aria-label="Page navigation"><a href="/home" aria-label="Home"><Home size={15} /></a><a href="/home#chapter-3" aria-label="Discord"><MessageCircle size={15} /></a><a href="https://github.com/risunCode/Cartethyia" target="_blank" rel="noreferrer" aria-label="GitHub"><GitFork size={15} /></a></nav></header>
    <main class="share-main">
      <Show when={state.error()}>{(error) => <section class="share-message share-message--error"><ShieldCheck size={20} /><div><strong>Passage unavailable</strong><p>{error()}</p></div></section>}</Show>
      <Show when={state.loading() && !monitor() && !setup()}><section class="share-message"><div class="share-loader" aria-hidden="true" /><div><strong>Opening shared passage</strong><p>Fetching the latest gateway details.</p></div></section></Show>
      <Show when={setup()}>{(data) => <section class="share-content share-content--setup"><div class="share-intro"><span class="share-kicker">One-time access</span><h1>Connect to<br /><em>{data().name}</em></h1><p>Use these credentials in your client. The key is shown only on this setup passage.</p></div><div class="share-setup-card"><CopyField label="Gateway base URL" value={data().baseUrl} onCopy={copy} copied={copied() === data().baseUrl} /><CopyField label="API key" value={data().key} onCopy={copy} copied={copied() === data().key} /><dl class="share-meta"><div><dt>Account</dt><dd>{data().name}</dd></div><div><dt>Expires</dt><dd>{formatDate(data().expiresAt)}</dd></div></dl></div></section>}</Show>
      <Show when={monitor()}>{(data) => <section class="share-content"><div class="share-intro share-intro--monitor"><div><span class="share-kicker">Read-only gateway monitor</span><h1>{data().name}</h1><p>Runtime state, capacity, and access policy in one quiet view.</p></div><div class={`share-status ${data().active && data().quotaAvailable ? "is-online" : "is-paused"}`}><span /><strong>{data().active ? "Online" : "Disabled"}</strong><small>{data().quotaAvailable ? "Quota available" : "Quota exhausted"}</small><small>{liveStatus()}</small></div></div><div class="share-grid share-grid--stats"><div class="share-stat"><span>Requests</span><strong>{data().totalRequests.toLocaleString()}</strong><small>{liveInFlight()} in flight</small></div><div class="share-stat"><span>Tokens</span><strong>{data().totalTokens.toLocaleString()}</strong></div></div><CopyField label="Gateway base URL" value={data().baseUrl} onCopy={copy} copied={copied() === data().baseUrl} /><div class="share-grid share-grid--quota"><QuotaBar label="Today" used={data().dailyUsed} limit={data().dailyLimit} remaining={data().dailyRemaining} /><QuotaBar label="This month" used={data().monthlyUsed} limit={data().monthlyLimit} remaining={data().monthlyRemaining} /><QuotaBar label="One-time" used={data().oneTimeUsed} limit={data().oneTimeLimit} remaining={data().oneTimeRemaining} /></div><div class="share-grid share-grid--details"><DetailList title="Gateway policy" icon={<Route size={14} />}><dl><div><dt>Rate limit</dt><dd>{formatNumber(data().rateLimitRpm)} RPM</dd></div><div><dt>Concurrency</dt><dd>{formatNumber(data().maxConcurrentRequests)}</dd></div><div><dt>Providers</dt><dd>{data().providerAllowlist ?? "All compatible providers"}</dd></div><div><dt>Allowed model</dt><dd>{data().modelAllowlist ?? "Policy controlled"}</dd></div></dl></DetailList></div><Show when={data().notes.title || data().notes.subtitle || data().notes.body}><aside class="share-note"><Activity size={16} /><div><Show when={data().notes.title}><strong>{data().notes.title}</strong></Show><Show when={data().notes.subtitle}><span>{data().notes.subtitle}</span></Show><Show when={data().notes.body}><p>{data().notes.body}</p></Show></div></aside></Show><a class="share-backlink" href="/home">Learn more about Cartethyia <ArrowUpRight size={14} /></a></section>}</Show>
    </main>
    <footer class="share-footer"><span>Self-hosted by design</span><span>Cartethyia · Read-only surface</span></footer>
  </div></div>;
}
