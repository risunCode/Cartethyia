/* @jsxImportSource solid-js */

import { Activity, BookOpen, Check, Clipboard, Gauge, GitFork, Home, KeyRound, MessageCircle, Route } from "lucide-solid";
import { createSignal, Show, type JSX } from "solid-js";

import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { copyToClipboard } from "./lib/clipboard";
import { useShareData, type ShareMonitorData, type ShareSetupData } from "./composables/browser/use-share-data";

interface ShareFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onCopy: (value: string) => void;
  readonly copied: boolean;
}

function ShareField(props: ShareFieldProps): JSX.Element {
  return (
    <div class="grid gap-2 rounded-xl border border-white/10 bg-white/[0.045] p-3.5">
      <div class="flex items-center justify-between gap-3">
        <span class="text-[9px] font-bold uppercase tracking-[0.16em] text-white/50">{props.label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="!h-7 !rounded-lg !border-cyan-200/30 !bg-cyan-200 !px-2.5 !text-[9px] !font-extrabold !uppercase !tracking-[0.12em] !text-[#07101d] hover:!bg-white"
          onClick={() => props.onCopy(props.value)}
        >
          {props.copied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
          {props.copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <code class="block overflow-wrap-anywhere rounded-lg border border-cyan-200/15 bg-[#010711]/60 px-3 py-2.5 font-mono text-xs leading-relaxed text-cyan-50">{props.value}</code>
    </div>
  );
}

function quotaPercent(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

interface QuotaMetricProps {
  readonly label: string;
  readonly used: number;
  readonly limit: number | null;
  readonly remaining: number | null;
}

function QuotaMetric(props: QuotaMetricProps): JSX.Element {
  const percent = quotaPercent(props.used, props.limit);
  return (
    <div class="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div class="flex items-center justify-between gap-3 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50">
        <span>{props.label}</span>
        <span class="text-cyan-100">{formatNumber(props.remaining)} left</span>
      </div>
      <div class="mt-3 flex items-end justify-between gap-3">
        <strong class="text-xl font-semibold text-white">{props.used.toLocaleString()}</strong>
        <span class="text-[10px] text-white/45">{props.limit === null ? "No cap" : `${props.limit.toLocaleString()} cap`}</span>
      </div>
      <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={`${props.label} usage`} aria-valuemin={0} aria-valuemax={props.limit ?? 0} aria-valuenow={props.limit === null ? 0 : props.used}>
        <span class="block h-full rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300 transition-[width] duration-700" style={{ width: `${props.limit === null ? 8 : Math.max(3, percent)}%` }} />
      </div>
    </div>
  );
}

function formatNumber(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString();
}

function formatDate(value: string | null): string {
  if (value === null) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SharePage(): JSX.Element {
  const isSetup = window.location.pathname.startsWith("/share/setup/");
  const dataPath = `${window.location.pathname.replace(/\/$/, "")}/data`;
  const dataState = useShareData<ShareMonitorData | ShareSetupData>(dataPath, isSetup ? undefined : 15_000);
  const [copiedValue, setCopiedValue] = createSignal<string | null>(null);

  document.title = "Cartethyia";

  const monitorData = (): ShareMonitorData | null => {
    const value = dataState.data();
    return !isSetup && value !== null ? value as ShareMonitorData : null;
  };
  const setupData = (): ShareSetupData | null => {
    const value = dataState.data();
    return isSetup && value !== null ? value as ShareSetupData : null;
  };

  const copy = async (value: string): Promise<void> => {
    const copied = await copyToClipboard(value);
    if (!copied) return;
    setCopiedValue(value);
    window.setTimeout(() => setCopiedValue((current) => (current === value ? null : current)), 1600);
  };

  return (
    <div class="relative min-h-screen overflow-hidden bg-[#07101d] font-sans text-white">
      <div class="fixed inset-0 bg-cover bg-center saturate-[.92]" style={{ "background-image": "url('/when_yah/25817331.webp')" }} aria-hidden="true" />
      <div class="fixed inset-0 bg-[linear-gradient(90deg,rgba(3,9,20,.94),rgba(3,9,20,.76)_35%,rgba(3,9,20,.24)_76%,rgba(3,9,20,.68)),linear-gradient(180deg,rgba(3,8,18,.76),rgba(3,8,18,.18)_42%,rgba(3,8,18,.92))]" aria-hidden="true" />
      <div class="fixed inset-0 opacity-[.045] [background-image:radial-gradient(rgba(255,255,255,.5)_.5px,transparent_.7px)] [background-size:4px_4px]" aria-hidden="true" />
      <div class="relative z-10 mx-auto flex min-h-screen w-[min(100%-2rem,1120px)] flex-col py-5 sm:w-[min(100%-2.5rem,1120px)] sm:py-7">
        <header class="flex items-center justify-between gap-5">
          <a class="inline-flex items-center gap-2.5 text-white no-underline" href="/">
            <img class="h-[34px] w-[34px] rounded-[10px] border border-cyan-200/35 bg-white object-cover shadow-xl" src="/favicon.webp" alt="" />
            <span class="grid gap-0.5">
              <strong class="font-serif text-[21px] font-normal leading-none">Cartethyia</strong>
              <small class="text-[8px] font-bold tracking-[0.2em] text-white/55">AI PROXY ROUTER</small>
            </span>
          </a>
          <nav class="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.045] p-1" aria-label="Primary navigation">
            <a class="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[10px] font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="/home" aria-label="Home"><Home size={14} aria-hidden="true" /><span class="hidden sm:inline">Home</span></a>
            <a class="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[10px] font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="/#chapter-3" aria-label="Discord"><MessageCircle size={14} aria-hidden="true" /><span class="hidden sm:inline">Discord</span></a>
            <a class="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[10px] font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="https://github.com/risunCode/Cartethyia" target="_blank" rel="noreferrer" aria-label="GitHub"><GitFork size={14} aria-hidden="true" /><span class="hidden sm:inline">GitHub</span></a>
          </nav>
        </header>

        <main class="flex flex-1 items-center justify-center py-12 sm:py-16">
          <Show when={monitorData() !== null || setupData() !== null}>
            <section class="motion-entry-enter" aria-label="Shared page">
              <Card surface="frame" density="comfortable" className="!overflow-hidden !rounded-[22px] !border-cyan-200/25 !bg-[linear-gradient(145deg,rgba(15,34,61,.9),rgba(4,12,26,.86))] !text-white !shadow-[0_30px_90px_rgba(0,0,0,.32),inset_0_1px_rgba(255,255,255,.08)]">
                <Show when={setupData()}>
                  {(data) => (
                    <div class="grid gap-2.5">
                      <p class="mb-1 text-xs leading-relaxed text-white/65">Use these values in your client. This one-time page will not show the key again after it is consumed.</p>
                      <ShareField label="Base URL" value={data().baseUrl} onCopy={copy} copied={copiedValue() === data().baseUrl} />
                      <ShareField label="API key" value={data().key} onCopy={copy} copied={copiedValue() === data().key} />
                      <div class="grid gap-2 border-t border-white/10 pt-4 text-[10px] text-white/55">
                        <div class="flex justify-between gap-4"><span>Account</span><strong class="text-right text-white/85">{data().name}</strong></div>
                        <div class="flex justify-between gap-4"><span>Expires</span><strong class="text-right text-white/85">{formatDate(data().expiresAt)}</strong></div>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={monitorData()}>
                  {(data) => (
                    <div class="grid gap-4">
                      <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                        <div class="flex items-center gap-3">
                          <span class={`grid h-10 w-10 place-items-center rounded-xl ${data().active && data().quotaAvailable ? "bg-emerald-300/15 text-emerald-200" : "bg-amber-300/15 text-amber-200"}`}><Activity size={18} aria-hidden="true" /></span>
                          <div><strong class="block text-sm text-white">{data().name}</strong><span class="text-[10px] text-white/50">{data().active ? "Gateway online" : "Gateway disabled"} · {data().quotaAvailable ? "Quota available" : "Quota exhausted"}</span></div>
                        </div>
                        <div class="rounded-xl border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-2 text-right"><span class="block text-[8px] font-bold uppercase tracking-[0.14em] text-cyan-100/55">In flight</span><strong class="text-lg text-cyan-50">{data().inFlight}</strong></div>
                      </div>
                      <div class="grid gap-2.5 sm:grid-cols-3">
                        <QuotaMetric label="Today" used={data().dailyUsed} limit={data().dailyLimit} remaining={data().dailyRemaining} />
                        <QuotaMetric label="This month" used={data().monthlyUsed} limit={data().monthlyLimit} remaining={data().monthlyRemaining} />
                        <QuotaMetric label="One-time" used={data().oneTimeUsed} limit={data().oneTimeLimit} remaining={data().oneTimeRemaining} />
                      </div>
                      <ShareField label="Gateway base URL" value={data().baseUrl} onCopy={copy} copied={copiedValue() === data().baseUrl} />
                      <div class="grid gap-2.5 sm:grid-cols-2">
                        <div class="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                          <div class="mb-3 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><KeyRound size={13} class="text-cyan-200" aria-hidden="true" />Key identity</div>
                          <dl class="grid gap-2 text-[10px] text-white/55">
                            <div class="flex justify-between gap-4"><dt>Prefix</dt><dd class="font-mono text-right text-cyan-50">{data().apiKey.prefix}</dd></div>
                            <div class="flex justify-between gap-4"><dt>Status</dt><dd class="text-right text-white/85">{data().apiKey.active ? "Active" : "Revoked"}</dd></div>
                            <div class="flex justify-between gap-4"><dt>Created</dt><dd class="text-right text-white/85">{formatDate(data().createdAt)}</dd></div>
                            <div class="flex justify-between gap-4"><dt>Last used</dt><dd class="text-right text-white/85">{formatDate(data().lastUsedAt)}</dd></div>
                          </dl>
                        </div>
                        <div class="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                          <div class="mb-3 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><Route size={13} class="text-cyan-200" aria-hidden="true" />Gateway policy</div>
                          <dl class="grid gap-2 text-[10px] text-white/55">
                            <div class="flex justify-between gap-4"><dt>Rate limit</dt><dd class="text-right text-white/85">{formatNumber(data().rateLimitRpm)} RPM</dd></div>
                            <div class="flex justify-between gap-4"><dt>Concurrency</dt><dd class="text-right text-white/85">{formatNumber(data().maxConcurrentRequests)}</dd></div>
                            <div class="flex justify-between gap-4"><dt>Providers</dt><dd class="max-w-[12rem] truncate text-right text-white/85">{data().providerAllowlist ?? "All compatible providers"}</dd></div>
                            <div class="flex justify-between gap-4"><dt>Models</dt><dd class="max-w-[12rem] truncate text-right text-white/85">{data().modelAllowlist ?? "Policy controlled"}</dd></div>
                          </dl>
                        </div>
                      </div>
                      <div class="grid gap-2.5 sm:grid-cols-2">
                        <div class="rounded-2xl border border-white/10 bg-white/[0.045] p-4"><div class="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><Gauge size={13} class="text-cyan-200" aria-hidden="true" />Capacity</div><p class="text-xs leading-6 text-white/65">Requests are admitted through this key&apos;s rate, quota, and concurrency boundaries.</p></div>
                        <div class="rounded-2xl border border-white/10 bg-white/[0.045] p-4"><div class="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><BookOpen size={13} class="text-cyan-200" aria-hidden="true" />Shared passage</div><p class="text-xs leading-6 text-white/65">This monitor is read-only. Values refresh automatically while the passage remains active.</p></div>
                      </div>
                      <Show when={data().notes.title || data().notes.subtitle || data().notes.body}>
                        <div class="rounded-2xl border border-cyan-200/15 bg-cyan-200/[0.05] p-4">
                          <div class="text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-100/60">Operator note</div>
                          <Show when={data().notes.title}><h3 class="mt-2 font-serif text-xl text-white">{data().notes.title}</h3></Show>
                          <Show when={data().notes.subtitle}><p class="mt-1 text-xs font-medium text-cyan-100/75">{data().notes.subtitle}</p></Show>
                          <Show when={data().notes.body}><p class="mt-3 whitespace-pre-wrap text-xs leading-6 text-white/65">{data().notes.body}</p></Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </Card>
            </section>
          </Show>
        </main>

        <footer class="flex justify-between gap-5 text-[8px] font-bold uppercase tracking-[0.16em] text-white/40 max-sm:grid max-sm:gap-2"><span>Self-hosted by design</span><span>Built with Bun + Elysia</span></footer>
      </div>
    </div>
  );
}
