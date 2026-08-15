/* @jsxImportSource solid-js */

import { ChevronDown } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { consoleFailure } from "../../lib/console-api";
import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { StatePanel } from "../../components/ui/state";
import { useProviders } from "../../components/model-picker";

interface ProviderInfo {
  id: string; name: string; icon: string; authKind: "none" | "session" | "oauth" | "api-key"; prefix: string; modelCount: number;
  capabilityCounts: { chat: number; media: number; websearch: number }; status: "ok" | "warn"; connections: number; supportsOAuth: boolean; supportsApiKey: boolean;
}
type ProviderCapability = keyof ProviderInfo["capabilityCounts"];
const PROVIDER_CAPABILITIES: readonly { value: ProviderCapability; label: string }[] = [{ value: "chat", label: "Chat" }, { value: "media", label: "Image / Video" }, { value: "websearch", label: "Web Search" }];
function providerCapabilityFromSearch(search: string): ProviderCapability { const requested = new URLSearchParams(search).get("capability"); return requested === "media" || requested === "websearch" ? requested : "chat"; }
const SECTIONS: { authKinds: ProviderInfo["authKind"][]; title: string }[] = [{ authKinds: ["none"], title: "Free Limited Providers" }, { authKinds: ["session", "oauth"], title: "OAuth Providers" }, { authKinds: ["api-key"], title: "API Key Providers" }];

function CustomProvidersSection() { return <StatePanel kind="degraded" title="Custom provider catalog unavailable" description="The daemon has not advertised a custom-provider catalog contract. No endpoint credentials are retained in dashboard state." />; }
function StatusLine(props: { provider: ProviderInfo }) {
  return <Show when={props.provider.authKind !== "none"} fallback={<Badge tone="ok">Ready</Badge>}><Show when={props.provider.connections > 0} fallback={<Badge>No connections</Badge>}><Badge tone="ok" className="gap-1.5"><StatusDot status="ok" />{props.provider.connections} Connected</Badge></Show></Show>;
}
function ProviderCard(props: { provider: ProviderInfo; capability: ProviderCapability }) {
  return <Card className="p-3 transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg"><A href={`/providers/${props.provider.id}?capability=${encodeURIComponent(props.capability)}`} class="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><div class="flex items-center gap-2.5"><ProviderIcon icon={props.provider.icon} name={props.provider.name} size={32} /><div class="min-w-0"><div class="flex items-center gap-1.5"><span class="truncate text-sm font-semibold">{props.provider.name}</span><Show when={props.provider.status === "warn"}><StatusDot status="warn" /></Show></div><div class="mt-1 flex flex-wrap items-center gap-1.5"><StatusLine provider={props.provider} /></div></div><div class="ml-auto flex shrink-0 flex-col items-end gap-1"><span class="rounded-md bg-[var(--kbd-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-3)]">{props.provider.prefix}/</span><Badge tone="info">{props.provider.modelCount} models</Badge></div></div></A></Card>;
}

export function ProvidersPage() {
  const location = useLocation();
  const query = useProviders();
  const capability = createSignal<ProviderCapability>(providerCapabilityFromSearch(location.search));
  const selectedCapability = capability[0];
  const setCapability = capability[1];
  const [visibleCount, setVisibleCount] = createSignal(12);
  const items = createMemo<ProviderInfo[]>(() => (query.data?.items ?? []).map((provider) => ({
    id: provider.id, name: provider.name, icon: provider.icon,
    authKind: (provider.credentialKind === "api_key" ? "api-key" : provider.credentialKind === "manual" ? "none" : provider.credentialKind ?? "none") as ProviderInfo["authKind"],
    prefix: provider.prefix, modelCount: provider.modelCount,
    capabilityCounts: provider.capabilityCounts ?? { chat: provider.modelCount, media: 0, websearch: 0 },
    status: provider.enabled !== false && (provider.credentialKind === "manual" || provider.credentialKind === "none" || provider.configured === true) ? "ok" : "warn",
    connections: provider.connections, supportsOAuth: provider.credentialKinds?.includes("oauth") ?? provider.credentialKind === "oauth", supportsApiKey: provider.credentialKinds?.includes("api_key") ?? provider.credentialKind === "api_key",
  })));
  const capabilityLabel = createMemo(() => PROVIDER_CAPABILITIES.find((option) => option.value === selectedCapability())?.label ?? "Chat");
  const capabilityItems = createMemo(() => items().filter((provider) => provider.capabilityCounts[selectedCapability()] > 0).map((provider) => ({ ...provider, modelCount: provider.capabilityCounts[selectedCapability()] })));
  const sections = createMemo(() => SECTIONS.map((section) => ({ ...section, providers: capabilityItems().filter((provider) => section.authKinds.includes(provider.authKind)).sort((left, right) => right.connections - left.connections || left.name.localeCompare(right.name)) })).filter((section) => section.providers.length > 0));
  const totalProviders = createMemo(() => sections().reduce((total, section) => total + section.providers.length, 0));
  const visibleProviders = createMemo(() => sections().reduce((total, section) => total + Math.min(visibleCount(), section.providers.length), 0));
  const hasMore = createMemo(() => visibleProviders() < totalProviders());
  createEffect(() => { selectedCapability(); setCapability(providerCapabilityFromSearch(location.search)); });
  createEffect(() => { selectedCapability(); setVisibleCount(12); });
  const registryLoading = createMemo(() => query.isPending || (query.isFetching && items().length === 0));
  const loadMore = () => { if (hasMore()) setVisibleCount((value) => value + 12); };

  return <div class="dashboard-page space-y-4"><Show when={!registryLoading()} fallback={<StatePanel kind="loading" title="Loading providers" description="Reading the provider registry…" />}><Show when={!(query.isError && items().length === 0)} fallback={<StatePanel kind={consoleFailure(query.error).degraded ? "degraded" : "error"} title={consoleFailure(query.error).degraded ? "Provider catalog degraded" : "Failed to load providers"} description={`${consoleFailure(query.error).message} (${consoleFailure(query.error).code})`} action={<Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button>} />}><div class="space-y-6"><div class="flex flex-col gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/55 px-4 py-3 backdrop-blur-xl lg:flex-row lg:items-center lg:justify-between"><div class="min-w-0"><label for="provider-capability" class="text-xs font-semibold uppercase tracking-wider text-[var(--text-3)]">Provider capability</label><p class="mt-1 text-xs text-[var(--text-3)]">Showing providers with models that support {capabilityLabel().toLowerCase()}.</p></div><div class="relative w-full shrink-0 lg:w-64"><select id="provider-capability" value={selectedCapability()} onChange={(event) => { setCapability(event.currentTarget.value as ProviderCapability); setVisibleCount(12); }} class="h-10 w-full appearance-none rounded-lg border border-[var(--inner-border)] bg-[var(--glass-bg-2)] px-3 pr-9 text-sm font-medium text-[var(--text-1)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"><For each={PROVIDER_CAPABILITIES}>{(option) => <option value={option.value}>{option.label}</option>}</For></select><ChevronDown size={15} aria-hidden="true" class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" /></div></div><Show when={selectedCapability() === "chat"}><CustomProvidersSection /></Show><Show when={sections().length > 0} fallback={<StatePanel kind="empty" title={`No ${capabilityLabel()} providers`} description="No configured models currently advertise this capability." />}><For each={sections()}>{(section) => <section class="space-y-3"><div class="flex items-baseline justify-between gap-2"><h2 class="text-base font-semibold tracking-tight">{section.title} ({section.providers.length})</h2></div><div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"><For each={section.providers.slice(0, visibleCount())}>{(provider) => <div class="min-w-0 [contain-intrinsic-size:160px] [content-visibility:auto]"><ProviderCard provider={provider} capability={selectedCapability()} /></div>}</For></div></section>}</For></Show><Show when={totalProviders() > 0}><button type="button" onClick={loadMore} class="flex min-h-10 w-full items-center justify-center rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/55 px-4 py-2 text-center text-[11px] text-[var(--text-3)] backdrop-blur-xl">{hasMore() ? `Showing ${visibleProviders()} of ${totalProviders()} providers · load more` : `Showing all ${totalProviders()} providers`}</button></Show></div></Show></Show></div>;
}
