import { useEffect, useState, type ReactElement } from "react";
import { Activity, BookOpen, Check, Clipboard, Gauge, Github as GithubIcon, Home, KeyRound, MessageCircle, Route } from "lucide-react";

import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { copyToClipboard } from "./lib/clipboard";
import { useShareData, type ShareMonitorData, type ShareSetupData } from "./hooks/use-share-data";

interface ShareFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onCopy: (value: string) => void;
  readonly copied: boolean;
}

function ShareField({ label, value, onCopy, copied }: ShareFieldProps): ReactElement {
  return (
    <div className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.045] p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/50">{label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="!h-7 !rounded-lg !border-cyan-200/30 !bg-cyan-200 !px-2.5 !text-[9px] !font-extrabold !uppercase !tracking-[0.12em] !text-[#07101d] hover:!bg-white"
          onClick={() => onCopy(value)}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <code className="block overflow-wrap-anywhere rounded-lg border border-cyan-200/15 bg-[#010711]/60 px-3 py-2.5 font-mono text-xs leading-relaxed text-cyan-50">{value}</code>
    </div>
  );
}


function quotaPercent(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function QuotaMetric({ label, used, limit, remaining }: { readonly label: string; readonly used: number; readonly limit: number | null; readonly remaining: number | null }): ReactElement {
  const percent = quotaPercent(used, limit);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="flex items-center justify-between gap-3 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50">
        <span>{label}</span>
        <span className="text-cyan-100">{formatNumber(remaining)} left</span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <strong className="text-xl font-semibold text-white">{used.toLocaleString()}</strong>
        <span className="text-[10px] text-white/45">{limit === null ? "No cap" : `${limit.toLocaleString()} cap`}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={limit ?? 0} aria-valuenow={limit === null ? 0 : used}>
        <span className="block h-full rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300 transition-[width] duration-700" style={{ width: `${limit === null ? 8 : Math.max(3, percent)}%` }} />
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

export function SharePage(): ReactElement {
  const isSetup = window.location.pathname.startsWith("/share/setup/");
  const dataPath = `${window.location.pathname.replace(/\/$/, "")}/data`;
  const dataState = useShareData<ShareMonitorData | ShareSetupData>(dataPath, isSetup ? undefined : 15_000);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Cartethyia";
  }, [isSetup]);

  const monitorData = !isSetup && dataState.data !== null ? dataState.data as ShareMonitorData : null;
  const setupData = isSetup && dataState.data !== null ? dataState.data as ShareSetupData : null;
  const copy = async (value: string): Promise<void> => {
    const copied = await copyToClipboard(value);
    if (!copied) return;
    setCopiedValue(value);
    window.setTimeout(() => setCopiedValue((current) => (current === value ? null : current)), 1600);
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07101d] font-sans text-white">
      <div className="fixed inset-0 bg-cover bg-center saturate-[.92]" style={{ backgroundImage: "url('/when_yah/25817331.webp')" }} aria-hidden="true" />
      <div className="fixed inset-0 bg-[linear-gradient(90deg,rgba(3,9,20,.94),rgba(3,9,20,.76)_35%,rgba(3,9,20,.24)_76%,rgba(3,9,20,.68)),linear-gradient(180deg,rgba(3,8,18,.76),rgba(3,8,18,.18)_42%,rgba(3,8,18,.92))]" aria-hidden="true" />
      <div className="fixed inset-0 opacity-[.045] [background-image:radial-gradient(rgba(255,255,255,.5)_.5px,transparent_.7px)] [background-size:4px_4px]" aria-hidden="true" />
      <div className="relative z-10 mx-auto flex min-h-screen w-[min(100%-2rem,1120px)] flex-col py-5 sm:w-[min(100%-2.5rem,1120px)] sm:py-7">
        <header className="flex items-center justify-between gap-5">
          <a className="inline-flex items-center gap-2.5 text-white no-underline" href="/">
            <img className="h-[34px] w-[34px] rounded-[10px] border border-cyan-200/35 bg-white object-cover shadow-xl" src="/favicon.webp" alt="" />
            <span className="grid gap-0.5">
              <strong className="font-serif text-[21px] font-normal leading-none">Cartethyia</strong>
              <small className="text-[8px] font-bold tracking-[0.2em] text-white/55">AI PROXY ROUTER</small>
            </span>
          </a>
          <nav className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.045] p-1" aria-label="Primary navigation">
            <a className="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[10px] font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="/" aria-label="Home"><Home size={14} aria-hidden="true" /><span className="hidden sm:inline">Home</span></a>
            <a className="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[10px] font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="/#chapter-3" aria-label="Discord"><MessageCircle size={14} aria-hidden="true" /><span className="hidden sm:inline">Discord</span></a>
            <a className="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[10px] font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="https://github.com/risunCode/Cartethyia" target="_blank" rel="noreferrer" aria-label="GitHub"><GithubIcon size={14} aria-hidden="true" /><span className="hidden sm:inline">GitHub</span></a>
          </nav>
        </header>

        <main className="flex flex-1 items-center justify-center py-12 sm:py-16">
          {(monitorData !== null || setupData !== null) ? <section className="motion-entry-enter" aria-label="Shared page">
            <Card surface="frame" density="comfortable" className="!overflow-hidden !rounded-[22px] !border-cyan-200/25 !bg-[linear-gradient(145deg,rgba(15,34,61,.9),rgba(4,12,26,.86))] !text-white !shadow-[0_30px_90px_rgba(0,0,0,.32),inset_0_1px_rgba(255,255,255,.08)]">
              {setupData !== null ? <div className="grid gap-2.5">
                <p className="mb-1 text-xs leading-relaxed text-white/65">Use these values in your client. This one-time page will not show the key again after it is consumed.</p>
                <ShareField label="Base URL" value={setupData.baseUrl} onCopy={copy} copied={copiedValue === setupData.baseUrl} />
                <ShareField label="API key" value={setupData.key} onCopy={copy} copied={copiedValue === setupData.key} />
                <div className="grid gap-2 border-t border-white/10 pt-4 text-[10px] text-white/55">
                  <div className="flex justify-between gap-4"><span>Account</span><strong className="text-right text-white/85">{setupData.name}</strong></div>
                  <div className="flex justify-between gap-4"><span>Expires</span><strong className="text-right text-white/85">{formatDate(setupData.expiresAt)}</strong></div>
                </div>
              </div> : null}
              {monitorData !== null ? <div className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <div className="flex items-center gap-3">
                    <span className={`grid h-10 w-10 place-items-center rounded-xl ${monitorData.active && monitorData.quotaAvailable ? "bg-emerald-300/15 text-emerald-200" : "bg-amber-300/15 text-amber-200"}`}><Activity size={18} aria-hidden="true" /></span>
                    <div><strong className="block text-sm text-white">{monitorData.name}</strong><span className="text-[10px] text-white/50">{monitorData.active ? "Gateway online" : "Gateway disabled"} · {monitorData.quotaAvailable ? "Quota available" : "Quota exhausted"}</span></div>
                  </div>
                  <div className="rounded-xl border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-2 text-right"><span className="block text-[8px] font-bold uppercase tracking-[0.14em] text-cyan-100/55">In flight</span><strong className="text-lg text-cyan-50">{monitorData.inFlight}</strong></div>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <QuotaMetric label="Today" used={monitorData.dailyUsed} limit={monitorData.dailyLimit} remaining={monitorData.dailyRemaining} />
                  <QuotaMetric label="This month" used={monitorData.monthlyUsed} limit={monitorData.monthlyLimit} remaining={monitorData.monthlyRemaining} />
                  <QuotaMetric label="One-time" used={monitorData.oneTimeUsed} limit={monitorData.oneTimeLimit} remaining={monitorData.oneTimeRemaining} />
                </div>
                <ShareField label="Gateway base URL" value={monitorData.baseUrl} onCopy={copy} copied={copiedValue === monitorData.baseUrl} />
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                    <div className="mb-3 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><KeyRound size={13} className="text-cyan-200" aria-hidden="true" />Key identity</div>
                    <dl className="grid gap-2 text-[10px] text-white/55">
                      <div className="flex justify-between gap-4"><dt>Prefix</dt><dd className="font-mono text-right text-cyan-50">{monitorData.apiKey.prefix}</dd></div>
                      <div className="flex justify-between gap-4"><dt>Status</dt><dd className="text-right text-white/85">{monitorData.apiKey.active ? "Active" : "Revoked"}</dd></div>
                      <div className="flex justify-between gap-4"><dt>Created</dt><dd className="text-right text-white/85">{formatDate(monitorData.createdAt)}</dd></div>
                      <div className="flex justify-between gap-4"><dt>Last used</dt><dd className="text-right text-white/85">{formatDate(monitorData.lastUsedAt)}</dd></div>
                    </dl>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                    <div className="mb-3 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><Route size={13} className="text-cyan-200" aria-hidden="true" />Gateway policy</div>
                    <dl className="grid gap-2 text-[10px] text-white/55">
                      <div className="flex justify-between gap-4"><dt>Rate limit</dt><dd className="text-right text-white/85">{formatNumber(monitorData.rateLimitRpm)} RPM</dd></div>
                      <div className="flex justify-between gap-4"><dt>Concurrency</dt><dd className="text-right text-white/85">{formatNumber(monitorData.maxConcurrentRequests)}</dd></div>
                      <div className="flex justify-between gap-4"><dt>Providers</dt><dd className="max-w-[12rem] truncate text-right text-white/85">{monitorData.providerAllowlist ?? "All compatible providers"}</dd></div>
                      <div className="flex justify-between gap-4"><dt>Models</dt><dd className="max-w-[12rem] truncate text-right text-white/85">{monitorData.modelAllowlist ?? "Policy controlled"}</dd></div>
                    </dl>
                  </div>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4"><div className="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><Gauge size={13} className="text-cyan-200" aria-hidden="true" />Capacity</div><p className="text-xs leading-6 text-white/65">Requests are admitted through this key&apos;s rate, quota, and concurrency boundaries.</p></div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4"><div className="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-white/50"><BookOpen size={13} className="text-cyan-200" aria-hidden="true" />Shared passage</div><p className="text-xs leading-6 text-white/65">This monitor is read-only. Values refresh automatically while the passage remains active.</p></div>
                </div>
                {monitorData.notes.title || monitorData.notes.subtitle || monitorData.notes.body ? <div className="rounded-2xl border border-cyan-200/15 bg-cyan-200/[0.05] p-4"><div className="text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-100/60">Operator note</div>{monitorData.notes.title ? <h3 className="mt-2 font-serif text-xl text-white">{monitorData.notes.title}</h3> : null}{monitorData.notes.subtitle ? <p className="mt-1 text-xs font-medium text-cyan-100/75">{monitorData.notes.subtitle}</p> : null}{monitorData.notes.body ? <p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-white/65">{monitorData.notes.body}</p> : null}</div> : null}
              </div> : null}
            </Card>
          </section> : null}
        </main>

        <footer className="flex justify-between gap-5 text-[8px] font-bold uppercase tracking-[0.16em] text-white/40 max-sm:grid max-sm:gap-2"><span>Self-hosted by design</span><span>Built with Bun + Elysia</span></footer>
      </div>
    </div>
  );
}
