import { Elysia, type HTTPHeaders } from "elysia";
import { consoleError } from "./errors";
import { sumAllTimeTokensForKey, sumDailyTokensForKey, sumMonthlyTokensForKey } from "./db/repos/usage";
import { getKeyInFlightCount } from "./tracking/key-in-flight";
import { getApiKeyById } from "./db/repos/api-keys";
import { resolveShareLinkState } from "./db/repos/share-links";
import { listModelsForKey } from "../routes/status";

const SHARE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const VIDEO_PATH = "/landing-assets/echoborn-cartethyia-awakens.1920x1080.mp4";

/** Returns the externally visible origin, honoring reverse-proxy forwarding headers. */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : url.protocol.slice(0, -1);
  if (forwardedHost) {
    try {
      return new URL(`${protocol}://${forwardedHost}`).origin;
    } catch {
      // Ignore malformed forwarding headers and fall back to the request URL.
    }
  }
  url.protocol = `${protocol}:`;
  return url.origin;
}

function nextUtcMidnight(): string {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

function formatShareToken(token: string): string {
  return JSON.stringify(token);
}

function renderSharePage(token: string, set: { headers: HTTPHeaders }): string {
  set.headers["content-type"] = "text/html; charset=utf-8";
  set.headers["content-security-policy"] = SHARE_CSP;
  set.headers["referrer-policy"] = "no-referrer";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Come check your Cartethyia API-key usage, save your tokens, and keep your budget and allowed models within reach.">
  <meta property="og:title" content="Cartethyia — Shared overview">
  <meta property="og:description" content="Come check your usage, save your tokens, and keep your Cartethyia API-key budget and allowed models within reach.">
  <meta property="og:image" content="/console/og_bansos.jpg">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:alt" content="Cartethyia shared API-key overview">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Cartethyia — Shared overview">
  <meta name="twitter:description" content="Come check your usage, save your tokens, and keep your budget and allowed models within reach.">
  <meta name="twitter:image" content="/console/og_bansos.jpg">
  <link rel="icon" type="image/png" href="/console/favicon.png">
  <title>Cartethyia - Shared overview</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,500;1,600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme: dark; --night: #081421; --deep: #0d2130; --ink: #eaf4f4; --muted: #a7bcc0; --aqua: #92e0d3; --gold: #e4c98f; --line: rgba(214, 239, 233, .2); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; overflow-x: hidden; background: var(--night); color: var(--ink); font: 14px/1.5 Manrope, ui-sans-serif, system-ui, sans-serif; }
    .backdrop { position: fixed; inset: 0; z-index: -2; width: 100%; height: 100%; object-fit: cover; filter: saturate(.8) brightness(.48); }
    body::after { content: ""; position: fixed; inset: 0; z-index: -1; background: radial-gradient(circle at 50% 14%, rgba(61, 120, 126, .22), transparent 38%), linear-gradient(180deg, rgba(3, 13, 23, .36), rgba(3, 13, 23, .96)); pointer-events: none; }
    main { width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 46px 0 64px; }
    .brand { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--gold); text-decoration: none; letter-spacing: .24em; font: 600 10px Cinzel, Georgia, serif; }
    .crest { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid rgba(228, 201, 143, .42); border-radius: 50%; color: var(--gold); background: rgba(5, 22, 34, .58); box-shadow: 0 0 0 7px rgba(228, 201, 143, .04), 0 0 24px rgba(228, 201, 143, .1); }
    .crest svg { width: 17px; height: 17px; }
    .crest img { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; }
    .status { display: inline-flex; align-items: center; gap: 7px; }
    .status-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
    .section { position: relative; margin-top: 22px; padding: 18px; border: 1px solid rgba(214, 239, 233, .18); border-radius: 4px; background: linear-gradient(135deg, rgba(13, 33, 48, .82), rgba(5, 19, 31, .62)); backdrop-filter: blur(18px); box-shadow: 0 18px 60px rgba(0, 0, 0, .18); }
    .section::before, .section::after { position: absolute; width: 18px; height: 18px; border-color: var(--gold); content: ""; pointer-events: none; }
    .section::before { top: -1px; left: -1px; border-top: 1px solid; border-left: 1px solid; }
    .section::after { right: -1px; bottom: -1px; border-right: 1px solid; border-bottom: 1px solid; }
    .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .section-title { margin: 0; color: var(--gold); font: 600 13px Cinzel, Georgia, serif; letter-spacing: .16em; text-transform: uppercase; }
    .section-caption { margin: 0; color: var(--muted); font: italic 13px "Cormorant Garamond", Georgia, serif; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .metric { min-width: 0; padding: 14px 12px; border: 1px solid rgba(214, 239, 233, .12); border-left: 2px solid rgba(228, 201, 143, .52); border-radius: 2px; background: rgba(4, 17, 29, .4); }
    .metric .value { margin-top: 9px; font: 600 clamp(20px, 2.3vw, 28px) Cinzel, Georgia, serif; letter-spacing: -.03em; }
    .connection-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .connection-field { min-width: 0; padding: 12px; border: 1px solid rgba(214, 239, 233, .12); border-radius: 2px; background: rgba(4, 17, 29, .42); }
    .words { border-left: 2px solid var(--gold); padding: 8px 0 8px 18px; }
    .words-big { margin: 0; color: var(--ink); font: 600 clamp(24px, 4vw, 42px)/1.04 Cinzel, Georgia, serif; letter-spacing: .01em; }
    .words-sub { margin: 8px 0 0; color: var(--gold); font: italic 20px/1.1 "Cormorant Garamond", Georgia, serif; }
    .words-body { max-width: 720px; margin: 13px 0 0; color: var(--muted); white-space: pre-wrap; }
    .field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .field-value { display: block; min-width: 0; margin-top: 8px; overflow: hidden; color: #dffaf8; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .copy-button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid rgba(146, 224, 211, .35); border-radius: 2px; padding: 5px 8px; color: var(--aqua); background: rgba(146, 224, 211, .06); font-size: 10px; font-weight: 700; cursor: pointer; }
    .copy-button:hover, .copy-button:focus-visible { border-color: var(--aqua); color: var(--ink); outline: 2px solid rgba(146, 224, 211, .24); outline-offset: 2px; }
    .models { width: 100%; max-height: 176px; margin-top: 0; overflow-y: auto; align-content: flex-start; padding: 12px; border: 1px dashed rgba(146, 224, 211, .32); border-radius: 4px; background: rgba(4, 17, 29, .28); }
    .models-copy-hint { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; color: var(--aqua); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .models-copy-hint svg { width: 15px; height: 15px; flex: 0 0 auto; }
    .models-list { display: flex; max-height: 112px; flex-wrap: wrap; gap: 6px; overflow-y: auto; align-content: flex-start; padding-right: 4px; }
    .models-card { min-height: 0; }
    .model { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid rgba(121, 230, 221, .22); border-radius: 999px; background: rgba(121, 230, 221, .08); color: #d8fffb; cursor: pointer; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .model:hover, .model:focus-visible { border-color: var(--aqua); background: rgba(121, 230, 221, .16); outline: 2px solid rgba(146, 224, 211, .2); outline-offset: 2px; }
    .model svg { width: 13px; height: 13px; flex: 0 0 auto; }
    .model-copy { display: flex; min-width: 0; flex-direction: column; align-items: flex-start; gap: 2px; }
    .model-name { overflow: hidden; max-width: 320px; text-overflow: ellipsis; white-space: nowrap; }
    .model-context { color: var(--muted); font: 10px/1 Manrope, ui-sans-serif, system-ui, sans-serif; letter-spacing: .04em; }
    .toast { position: fixed; z-index: 5; right: 18px; bottom: 18px; display: inline-flex; align-items: center; gap: 9px; max-width: min(360px, calc(100% - 36px)); padding: 11px 14px; border: 1px solid rgba(146, 224, 211, .42); border-radius: 999px; color: var(--ink); background: rgba(5, 22, 34, .94); box-shadow: 0 14px 34px rgba(0, 0, 0, .3); font-size: 12px; font-weight: 700; }
    .toast[hidden] { display: none; }
    .toast-icon { display: grid; width: 19px; height: 19px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: var(--night); background: var(--aqua); }
    .toast-icon svg { width: 12px; height: 12px; }
    @media (prefers-reduced-motion: no-preference) { .toast { animation: toast-in .18s ease-out; } }
    @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .status-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    .status-card .value { font-family: Cinzel, Georgia, serif; }
    header { position: relative; display: block; margin-bottom: 32px; text-align: center; }
    h1 { margin: 24px 0 3px; color: var(--ink); font: 600 clamp(30px, 5vw, 52px)/.98 Cinzel, Georgia, serif; letter-spacing: .05em; text-transform: uppercase; text-wrap: balance; }
    .subtitle { margin: 0; color: var(--muted); font: italic 18px "Cormorant Garamond", Georgia, serif; }
    .status { position: absolute; top: 52px; right: 0; color: var(--aqua); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .label { color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .value { margin-top: 12px; font-size: clamp(20px, 2.5vw, 28px); font-weight: 800; letter-spacing: -.04em; }
    .detail { margin-top: 3px; color: var(--muted); font-size: 12px; }
    .empty { color: var(--muted); font-size: 13px; }
    .disabled-state { display: grid; gap: 10px; margin-top: 22px; padding: clamp(28px, 7vw, 64px) 24px; border: 1px solid rgba(228, 201, 143, .34); border-radius: 4px; background: linear-gradient(135deg, rgba(13, 33, 48, .88), rgba(5, 19, 31, .7)); backdrop-filter: blur(18px); box-shadow: 0 18px 60px rgba(0, 0, 0, .2); text-align: center; }
    .disabled-state[hidden] { display: none; }
    .disabled-icon { display: grid; width: 44px; height: 44px; margin: 0 auto; place-items: center; border: 1px solid rgba(228, 201, 143, .42); border-radius: 50%; color: var(--gold); font-size: 20px; }
    .disabled-state h2 { margin: 0; color: var(--gold); font: 600 clamp(20px, 4vw, 30px) Cinzel, Georgia, serif; }
    .disabled-state p { max-width: 520px; margin: 0 auto; color: var(--muted); }
    .footer { margin-top: 18px; color: var(--muted); font: italic 13px "Cormorant Garamond", Georgia, serif; text-align: center; }
    @media (max-width: 760px) { main { padding-top: 30px; } .status { position: static; justify-content: center; margin-top: 14px; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .connection-grid { grid-template-columns: 1fr; } }
    @media (max-width: 430px) { .metrics { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <video class="backdrop" autoplay muted loop playsinline preload="metadata" poster="/landing-assets/cartethyia-profile-header.jpg" aria-hidden="true"><source src="${VIDEO_PATH}" type="video/mp4"></video>
  <main>
    <header>
      <div><a class="brand" href="/"><span class="crest" aria-hidden="true"><img src="/console/cartethyia-sidebar.gif" alt="" width="42" height="42"></span><span>CARTETHYIA</span></a><h1 id="title">Shared overview</h1><p class="subtitle">Live token and model visibility for this API key.</p></div>
      <div class="status" id="status"><span class="status-dot" aria-hidden="true"></span><span id="statusText">Loading...</span></div>
    </header>
    <section class="disabled-state" id="disabledState" hidden aria-live="polite"><div class="disabled-icon" aria-hidden="true">—</div><h2>This API key is currently disabled</h2><p id="disabledMessage">The owner has temporarily turned off this key. Usage, connection details, and allowed models are unavailable until it is enabled again.</p></section>
    <section class="section" id="metricsSection" aria-labelledby="metrics-title">
      <div class="section-heading"><h2 class="section-title" id="metrics-title">Usage overview</h2><p class="section-caption">Live values, refreshed every 15 seconds</p></div>
      <div class="metrics" aria-live="polite">
        <article class="metric"><div class="label">Total remaining</div><div class="value" id="remaining">-</div><div class="detail" id="remainingDetail">Loading budget...</div></article>
        <article class="metric"><div class="label">Today tokens</div><div class="value" id="today">-</div><div class="detail">UTC daily usage</div></article>
        <article class="metric" id="resetCard"><div class="label">Daily reset</div><div class="value" id="reset">-</div><div class="detail">UTC calendar boundary</div></article>
        <article class="metric"><div class="label">All-time used</div><div class="value" id="total">-</div><div class="detail">Measured input + output</div></article>
        <article class="metric"><div class="label">In flight</div><div class="value" id="inFlight">-</div><div class="detail">Active requests for this key</div></article>
      </div>
    </section>
    <section class="section" id="connectionSection" aria-labelledby="connection-title">
      <div class="section-heading"><h2 class="section-title" id="connection-title">Connection</h2><p class="section-caption">Copy and paste into your client</p></div>
      <div class="connection-grid">
        <div class="connection-field"><div class="field-head"><span class="label">Base URL</span><button class="copy-button" type="button" data-copy-target="baseUrl"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button></div><span class="field-value" id="baseUrl">-</span></div>
        <div class="connection-field"><div class="field-head"><span class="label">API key</span><button class="copy-button" type="button" data-copy-target="apiKey"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button></div><span class="field-value" id="apiKey">-</span></div>
      </div>
    </section>
    <section class="section" id="wordsSection" aria-labelledby="words-title" hidden>
      <div class="section-heading"><h2 class="section-title" id="words-title">Kata-kata hari ini</h2><p class="section-caption">A note from this API key</p></div>
      <div class="words"><p class="words-big" id="wordsBig"></p><p class="words-sub" id="wordsSub"></p><p class="words-body" id="wordsBody"></p></div>
    </section>
    <section class="section models-card" id="modelsSection" aria-labelledby="models-title"><div class="section-heading"><div><h2 class="section-title" id="models-title">Available models</h2><p class="section-caption">Allowed for this key</p></div><button class="copy-button" type="button" data-copy-target="models" aria-label="Copy all allowed models"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2 2h9a2 2 0 0 1 2 2v1"/></svg><span data-copy-label>Copy all models</span></button></div><div class="models" id="models"><span class="models-copy-hint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Click a model to copy its ID</span></span><span class="models-list" id="modelsList"><span class="empty">Loading models…</span></span></div></section>
    <section class="section status-card" id="statusSection" aria-labelledby="status-title"><div><h2 class="section-title" id="status-title">Key status</h2><p class="detail" id="keyDetail">This page refreshes automatically.</p></div><div class="value" id="keyStatus">-</div></section>
    <p class="footer">Shared by Cartethyia Router - refreshed every 15 seconds</p>
  </main>
  <div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true" hidden><span class="toast-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span><span id="toastText"></span></div>
  <script>
    const token = ${formatShareToken(token)};
    const number = (value) => value === null ? "Unlimited" : new Intl.NumberFormat().format(value);
  const contextSize = (value) => {
    if (typeof value !== "number") return "Context unavailable";
    if (value >= 1000000) return (value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1) + "M context";
    if (value >= 1000) return Math.round(value / 1000) + "K context";
    return new Intl.NumberFormat().format(value) + " context";
  };
    const render = (data) => {
      const disabledState = document.getElementById("disabledState");
      const hiddenSections = ["metricsSection", "connectionSection", "modelsSection"];
      if (data.disabled) {
        document.title = "Cartethyia - " + data.key.name + " (disabled)";
        document.getElementById("title").textContent = data.key.name;
        document.getElementById("statusText").textContent = "Disabled";
        document.getElementById("keyStatus").textContent = "Disabled";
        document.getElementById("keyDetail").textContent = "This share page is waiting for the API key to be enabled again.";
        document.getElementById("disabledMessage").textContent = data.message;
        disabledState.hidden = false;
        for (const id of hiddenSections) document.getElementById(id).hidden = true;
        return;
      }
      disabledState.hidden = true;
      for (const id of hiddenSections) document.getElementById(id).hidden = false;
      document.getElementById("baseUrl").textContent = data.baseUrl;
      document.getElementById("apiKey").textContent = data.apiKey;
      const hasWords = Boolean(data.words.bigText || data.words.subText || data.words.body);
      document.getElementById("wordsSection").hidden = !hasWords;
      document.getElementById("wordsBig").textContent = data.words.bigText || "";
      document.getElementById("wordsSub").textContent = data.words.subText || "";
      document.getElementById("wordsBody").textContent = data.words.body || "";

      document.title = "Cartethyia - " + data.key.name;
      document.getElementById("title").textContent = data.key.name;
      document.getElementById("statusText").textContent = data.key.active ? "Live" : "Revoked";
      document.getElementById("remaining").textContent = number(data.totalRemaining);
      document.getElementById("resetCard").hidden = data.totalRemainingKind === "one-time";
      document.getElementById("remainingDetail").textContent = data.totalRemainingKind === "one-time" ? "one-time budget remaining" : data.totalRemainingKind === "monthly" ? "monthly budget remaining" : "no total cap configured";
      document.getElementById("today").textContent = new Intl.NumberFormat().format(data.todayTokens);
      document.getElementById("reset").textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(data.dailyResetAt));
      document.getElementById("total").textContent = new Intl.NumberFormat().format(data.totalTokens);
      document.getElementById("inFlight").textContent = new Intl.NumberFormat().format(data.inFlight);
      document.getElementById("keyStatus").textContent = data.key.active ? "Active" : "Revoked";
      document.getElementById("keyDetail").textContent = data.totalRemainingKind === "one-time" ? "One-time budget: " + number(data.totalRemaining) + " remaining" : data.daily.limit === null ? "Daily budget: unlimited" : "Daily budget: " + number(data.daily.limit - data.daily.used) + " remaining";
      const models = document.getElementById("models");
      const modelsList = document.getElementById("modelsList");
      models.dataset.copyValue = data.availableModels.map((model) => model.id).join("\\n");
      modelsList.textContent = "";
      if (data.availableModels.length === 0) { const empty = document.createElement("span"); empty.className = "empty"; empty.textContent = "No models available for this key."; modelsList.appendChild(empty); return; }
      for (const model of data.availableModels) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "model";
        chip.dataset.copyTarget = "model";
        chip.dataset.copyValue = model.id;
        chip.dataset.copyMessage = "Copied " + model.id;
        chip.setAttribute("aria-label", "Copy model " + model.id);
        chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span class="model-copy"><span class="model-name"></span><span class="model-context"></span></span>';
        chip.querySelector(".model-name").textContent = model.id;
        chip.querySelector(".model-context").textContent = contextSize(model.contextWindow);
        modelsList.appendChild(chip);
      }
    };
    let toastTimer;
    const showToast = (message) => {
      const toast = document.getElementById("toast");
      document.getElementById("toastText").textContent = message;
      toast.hidden = false;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { toast.hidden = true; }, 1800);
    };
    document.addEventListener("click", async (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-copy-target]") : null;
      if (!(target instanceof HTMLButtonElement) || target.disabled) return;
      const source = document.getElementById(target.dataset.copyTarget || "");
      const value = target.dataset.copyValue || source?.dataset.copyValue || source?.textContent?.trim();
      if (!value || value === "-") return;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        showToast("Copy unavailable — use HTTPS or copy manually.");
        return;
      }
      const label = target.querySelector("[data-copy-label]");
      if (label) {
        const previous = label.textContent;
        label.textContent = "Copied";
        window.setTimeout(() => { label.textContent = previous; }, 1200);
      }
      showToast(target.dataset.copyMessage || "Copied to clipboard");
    });
    const load = async () => {
      try {
        const response = await fetch("/share/" + token + "/data", { cache: "no-store" });
        if (!response.ok) throw new Error("unavailable");
        render(await response.json());
      } catch { document.getElementById("statusText").textContent = "Unavailable"; }
    };
    void load();
    window.setInterval(() => void load(), 15000);
  </script>
</body>
</html>`;
}

export const sharePublicRoutes = new Elysia()
  .get("/share/:token", ({ params, set }) => renderSharePage(params.token, set))
  .get("/share/:token/data", ({ params, request, set }) => {
    const share = resolveShareLinkState(params.token);
    if (share.status === "not_found" || !share.key) {
      set.status = 404;
      return consoleError("not_found", "share link not found or inactive");
    }
    const key = share.key;
    if (share.status === "disabled") {
      set.headers["cache-control"] = "no-store";
      return { disabled: true, key: { name: key.name, active: false }, message: "The owner has temporarily disabled this API key. This shared page will become available again when the key is enabled." };
    }
    const credential = getApiKeyById(key.id);
    if (!credential) {
      set.status = 404;
      return consoleError("not_found", "key credential not found");
    }
    set.headers["cache-control"] = "no-store";
    const dailyUsed = sumDailyTokensForKey(key.id);
    const totalTokens = sumAllTimeTokensForKey(key.id);
    const daily = key.dailyTokenLimit === null
      ? { limit: null, used: dailyUsed, remaining: null }
      : { limit: key.dailyTokenLimit, used: dailyUsed, remaining: Math.max(0, key.dailyTokenLimit - dailyUsed) };
    const monthlyUsed = sumMonthlyTokensForKey(key.id);
    const monthlyRemaining = key.monthlyTokenLimit === null
      ? null
      : Math.max(0, key.monthlyTokenLimit - monthlyUsed);
    const oneTimeRemaining = key.oneTimeTokenLimit === null
      ? null
      : Math.max(0, key.oneTimeTokenLimit - key.oneTimeTokensUsed);
    const totalRemaining = oneTimeRemaining ?? monthlyRemaining;
    return {
      key: { name: key.name, active: key.active },
      baseUrl: new URL("/v1", publicOrigin(request)).toString().replace(/\/$/, ""),
      apiKey: credential.key,
      words: { bigText: key.quoteBigText, subText: key.quoteSubText, body: key.quoteBody },
      todayTokens: dailyUsed,
      totalTokens,
      inFlight: getKeyInFlightCount(key.id),
      dailyResetAt: nextUtcMidnight(),
      daily,
      totalRemaining,
      totalRemainingKind: oneTimeRemaining !== null ? "one-time" : monthlyRemaining !== null ? "monthly" : null,
      availableModels: listModelsForKey(key).map((model) => ({ id: model.id, contextWindow: model.context_window })),
    };
  });
