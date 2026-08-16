
import { useQuery } from "@tanstack/solid-query";
import { Boxes, Check, Search } from "lucide-solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import { consoleCatalog } from "../lib/console-api";
import { qk } from "../lib/query-keys";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { Dialog } from "./ui/dialog";
import { Input, Label } from "./ui/input";
import { ProviderIcon } from "./provider-icon";
import { Popout } from "../lib/popout";

export interface ProviderSummary {
  id: string; name: string; icon: string; prefix: string; modelCount: number; connections: number;
  models?: CatalogModel[];
  capabilityCounts?: { chat: number; media: number; websearch: number };
  credentialKind?: "api_key" | "oauth" | "session" | "manual" | "none";
  credentialKinds?: Array<"api_key" | "oauth" | "session" | "manual" | "none">;
  enabled?: boolean; configured?: boolean;
}
interface CatalogModel {
  id?: string; modelId?: string; name?: string; enabled?: boolean; images?: boolean;
  capabilities?: { chat?: boolean; media?: boolean; imageGeneration?: boolean; videoGeneration?: boolean; websearch?: boolean };
}
export type ModelPickerCapability = "chat" | "image" | "video";
export interface ModelCapabilityFlags { chat: boolean; media: boolean; imageGeneration: boolean; videoGeneration: boolean; }
export interface FlatModelEntry { provider: ProviderSummary; qualified: string; capabilities: ModelCapabilityFlags; }

export function useProviders() {
  return useQuery(() => ({
    queryKey: qk.catalog.providers,
    queryFn: async () => {
      const catalog = await consoleCatalog();
      return { items: catalog.map((provider) => ({
        id: provider.id, name: provider.name, icon: provider.id, prefix: provider.id,
        modelCount: provider.modelCount, connections: provider.accountCount,
        models: provider.models.map((model) => ({ id: model.id, enabled: model.enabled, capabilities: model.capabilities })),
        capabilityCounts: {
          chat: provider.models.filter((model) => model.enabled && model.capabilities.chat !== false).length,
          media: provider.models.filter((model) => model.enabled && model.capabilities.media === true).length,
          websearch: provider.models.filter((model) => model.enabled && model.capabilities.websearch === true).length,
        },
        credentialKind: provider.credentialKind === "unknown" ? "manual" : provider.credentialKind,
        credentialKinds: provider.credentialKind === "unknown" ? [] : [provider.credentialKind],
        enabled: provider.enabled, configured: provider.configured,
      })) as ProviderSummary[] }; 
    }, staleTime: 60_000, refetchOnWindowFocus: false, retry: 1,
  }));
}

interface ModelCatalogState { items: FlatModelEntry[]; isLoading: boolean; isError: boolean; }
function canLoadCatalog(provider: ProviderSummary): boolean { return provider.credentialKind === "none" || provider.configured === true; }
function modelCapabilityFlags(model: CatalogModel): ModelCapabilityFlags {
  const declared = model.capabilities;
  const imageGeneration = declared?.imageGeneration ?? declared?.media === true;
  const videoGeneration = declared?.videoGeneration === true;
  return { chat: declared?.chat ?? true, media: declared?.media ?? (imageGeneration || videoGeneration), imageGeneration, videoGeneration };
}
export function useModelCatalogState(providers: ProviderSummary[], enabled: boolean): ModelCatalogState {
  const items = enabled ? providers.flatMap((provider) => {
    if (!canLoadCatalog(provider)) return [];
    return (provider.models ?? []).flatMap((model) => {
      const modelId = model.id ?? model.modelId;
      if (!modelId || model.enabled === false) return [];
      const qualified = modelId.startsWith(`${provider.prefix}/`) ? modelId : `${provider.prefix}/${modelId}`;
      return [{ provider, qualified, capabilities: modelCapabilityFlags(model) }];
    });
  }) : [];
  return { items, isLoading: false, isError: false };
}
export function useModelCatalog(providers: ProviderSummary[], enabled: boolean): FlatModelEntry[] { return useModelCatalogState(providers, enabled).items; }
type PickerMode = "providers" | "models";

export function ModelPickerModal(props: {
  open: boolean; onClose: () => void; mode: PickerMode; selected: string[]; onToggle: (value: string) => void; onSelectOne?: (value: string) => void; title?: string;
}) {
  const providersQuery = useProviders();
  const providers = createMemo(() => providersQuery.data?.items ?? []);
  const catalog = createMemo(() => useModelCatalogState(providers(), props.open && props.mode === "models").items);
  const [search, setSearch] = createSignal("");
  const [providerFilter, setProviderFilter] = createSignal<string | null>(null);
  const filteredModels = createMemo(() => { const q = search().trim().toLowerCase(); return catalog().filter((entry) => (!providerFilter() || entry.provider.id === providerFilter()) && (!q || entry.qualified.toLowerCase().includes(q))); });
  const filteredProviders = createMemo(() => { const q = search().trim().toLowerCase(); return providers().filter((provider) => !q || provider.name.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q)); });
  const pick = (value: string) => { if (props.onSelectOne) { props.onSelectOne(value); props.onClose(); } else props.onToggle(value); };
  return <Dialog open={props.open} onClose={props.onClose} title={props.title ?? (props.mode === "providers" ? "Add provider" : "Add model")} wide>
    <div class="space-y-3">
      <div class="relative"><Search size={14} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" /><Input value={search()} onInput={(e) => setSearch(e.currentTarget.value)} placeholder={props.mode === "providers" ? "Search providers…" : "Search models…"} class="pl-8" /></div>
      <Show when={props.mode === "models" && providers().length > 0}><div class="flex flex-wrap gap-1.5"><button type="button" onClick={() => setProviderFilter(null)} class={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors", !providerFilter() ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)]")}>All providers</button><For each={providers()}>{(provider) => <button type="button" onClick={() => setProviderFilter(provider.id === providerFilter() ? null : provider.id)} class={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors", providerFilter() === provider.id ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)]")}><ProviderIcon icon={provider.icon} name={provider.name} size={14} className="rounded" />{provider.name}</button>}</For></div></Show>
      <div class="max-h-80 overflow-y-auto rounded-xl border border-[var(--inner-border)]">
        <Show when={!((props.mode === "providers" && providersQuery.isPending) || (props.mode === "models" && false))} fallback={<div class="py-8 text-center text-xs text-[var(--text-3)]">Loading provider and model catalog…</div>}>
          <Show when={!providersQuery.isError} fallback={<div class="py-8 text-center text-xs text-[var(--red)]">Unable to load provider and model catalog.</div>}>
            <Show when={props.mode === "providers"} fallback={<><For each={filteredModels()}>{(entry) => <button type="button" onClick={() => pick(entry.qualified)} class="flex w-full items-center gap-2.5 border-b border-[var(--inner-border)] px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--hover)]"><ProviderIcon icon={entry.provider.icon} name={entry.provider.name} size={22} /><div class="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold text-[var(--text-1)]">{entry.qualified}</div><Show when={props.selected.includes(entry.qualified)}><Badge tone="accent">added</Badge></Show></button>}</For><Show when={filteredModels().length === 0}><div class="py-8 text-center text-xs text-[var(--text-3)]">No models match your search.</div></Show></>}>
              <Show when={filteredProviders().length > 0} fallback={<div class="py-8 text-center text-xs text-[var(--text-3)]">No providers match your search.</div>}><For each={filteredProviders()}>{(provider) => <button type="button" onClick={() => pick(provider.id)} class="flex w-full items-center gap-2.5 border-b border-[var(--inner-border)] px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--hover)]"><ProviderIcon icon={provider.icon} name={provider.name} size={22} /><div class="min-w-0 flex-1"><div class="font-semibold text-[var(--text-1)]">{provider.name}</div><div class="text-[10.5px] text-[var(--text-3)]">{provider.prefix} · {provider.modelCount} models</div></div><Show when={props.selected.includes(provider.id)}><Badge tone="accent">added</Badge></Show></button>}</For></Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  </Dialog>;
}

export function InlineModelBrowser(props: { mode: PickerMode; selected: string[]; onToggle: (value: string) => void; onSelectOne?: (value: string) => void }) {
  const [search, setSearch] = createSignal("");
  const providersQuery = useProviders();
  const providers = createMemo(() => providersQuery.data?.items ?? []);
  const catalog = createMemo(() => useModelCatalogState(providers(), props.mode === "models").items);
  const query = createMemo(() => search().trim().toLowerCase());
  const filteredProviders = createMemo(() => providers().filter((provider) => !query() || provider.name.toLowerCase().includes(query()) || provider.id.toLowerCase().includes(query())));
  const filteredModels = createMemo(() => catalog().filter((entry) => !query() || entry.qualified.toLowerCase().includes(query())));
  const pick = (value: string) => { props.onSelectOne ? props.onSelectOne(value) : props.onToggle(value); setSearch(""); };
  const addFromSearch = () => { const value = search().trim(); if (!value || props.selected.includes(value)) return; props.onToggle(value); setSearch(""); };
  return <div class="space-y-2"><div class="relative"><Search size={14} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" /><Input value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder={props.mode === "providers" ? "Search providers…" : "Search models…"} class="pl-8" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFromSearch(); } }} /></div><div class="max-h-[60vh] space-y-3 overflow-y-auto rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3"><Show when={!providersQuery.isPending} fallback={<div class="py-6 text-center text-[11px] text-[var(--text-3)]">Loading provider catalog…</div>}><Show when={props.mode === "providers"} fallback={<div class="flex flex-wrap gap-1.5"><For each={filteredModels()}>{(entry) => <button type="button" onClick={() => pick(entry.qualified)} class={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", props.selected.includes(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}><ProviderIcon icon={entry.provider.icon} name={entry.provider.name} size={13} /><span class="truncate">{entry.qualified}</span></button>}</For></div>}><div class="flex flex-wrap gap-1.5"><For each={filteredProviders()}>{(provider) => <button type="button" onClick={() => pick(provider.id)} class="flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[11px] transition-colors hover:bg-[var(--surface-1)]"><ProviderIcon icon={provider.icon} name={provider.name} size={18} /><span class="truncate font-semibold text-[var(--text-1)]">{provider.name}</span></button>}</For></div></Show><Show when={!providersQuery.isPending && props.mode === "models" && filteredModels().length === 0}><div class="py-6 text-center text-[11px] text-[var(--text-3)]">No models match.</div></Show></Show></div></div>;
}

export function ConfiguredModelPicker(props: { value: string | string[]; onChange: ((value: string) => void) | ((values: string[]) => void); placeholder?: string; capability?: ModelPickerCapability; multiple?: boolean; disabled?: boolean }) {
  const selectedValues = createMemo(() => Array.isArray(props.value) ? props.value : [props.value]);
  const value = createMemo(() => selectedValues()[0] ?? "");
  const providersQuery = useProviders();
  const providers = createMemo(() => providersQuery.data?.items ?? []);
  const catalog = createMemo(() => useModelCatalogState(providers(), true).items.filter((entry) => props.capability === undefined || (props.capability === "chat" ? entry.capabilities.chat : props.capability === "image" ? entry.capabilities.imageGeneration : entry.capabilities.videoGeneration)));
  const [open, setOpen] = createSignal(false); const [search, setSearch] = createSignal("");
  const groups = createMemo(() => { const q = search().trim().toLowerCase(); const grouped = new Map<string, { provider: ProviderSummary; models: FlatModelEntry[] }>(); for (const entry of catalog()) { if (q && !entry.qualified.toLowerCase().includes(q)) continue; const group = grouped.get(entry.provider.id); if (group) group.models.push(entry); else grouped.set(entry.provider.id, { provider: entry.provider, models: [entry] }); } return [...grouped.values()]; });
  const selectValue = (nextValue: string) => { if (props.multiple) { const next = selectedValues().includes(nextValue) ? selectedValues().filter((item) => item !== nextValue) : [...selectedValues(), nextValue]; (props.onChange as (values: string[]) => void)(next); } else { (props.onChange as (selected: string) => void)(nextValue); setOpen(false); } };
  const selectedProvider = createMemo(() => providers().find((provider) => value().startsWith(`${provider.prefix}/`)));
  return <Popout open={open()} onClose={() => setOpen(false)} width={400} preferUp matchTriggerWidth={false} panelClassName="model-picker-panel w-[min(400px,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-[var(--inner-border)] bg-[var(--popover-bg)] shadow-2xl" trigger={(ref) => <button ref={(element) => { ref.current = element; }} type="button" onClick={() => setOpen(!open())} disabled={props.disabled} class="flex h-9 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 text-left text-[11.5px]" aria-expanded={open()}>{selectedProvider() ? <ProviderIcon icon={selectedProvider()!.icon} name={selectedProvider()!.name} size={15} /> : <Boxes size={14} class="shrink-0 text-[var(--text-3)]" />}<span class={cn("min-w-0 flex-1 truncate font-mono", selectedValues().length === 0 && "font-sans text-[var(--text-3)]")}>{props.multiple ? (selectedValues().length > 0 ? `${selectedValues().length} models selected` : props.placeholder || "Select configured models…") : (value() || props.placeholder || "Select a configured model…")}</span><Check size={14} class="shrink-0 text-[var(--text-3)]" /></button>} panel={() => <><div class="border-b border-[var(--inner-border)] p-2"><Input value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Search configured models…" /></div><div class="h-[min(22rem,58vh)] overflow-y-auto p-1.5"><Show when={groups().length > 0} fallback={<div class="py-8 text-center text-[11px] text-[var(--text-3)]">No configured models match.</div>}><For each={groups()}>{(group) => <section class="mb-2.5"><div class="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]"><ProviderIcon icon={group.provider.icon} name={group.provider.name} size={13} /><span>{group.provider.name}</span></div><div class="model-picker-grid"><For each={group.models}>{(entry) => <button type="button" onClick={() => selectValue(entry.qualified)} class={cn("inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-mono hover:bg-[var(--accent-soft)]", selectedValues().includes(entry.qualified) && "bg-[var(--accent-soft)] text-[var(--accent)]")}>{entry.qualified}</button>}</For></div></section>}</For></Show></div></>} />;
}

export function ModelPickerField(props: { label: string; hint?: string; values: string[]; onChange: (values: string[]) => void; mode?: PickerMode; disabled?: boolean }) { return <div><Label>{props.label}</Label><Show when={props.hint}><p class="-mt-1 mb-1.5 text-[10.5px] text-[var(--text-3)]">{props.hint}</p></Show><ConfiguredModelPicker value={props.values} multiple onChange={(next: string | string[]) => props.onChange(Array.isArray(next) ? next : [next])} disabled={props.disabled} placeholder="Add configured models…" /></div>; }
export function ModelTargetPicker(props: { value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) { return <div class="space-y-2"><Input value={props.value} onInput={(event) => props.onChange(event.currentTarget.value)} placeholder={props.placeholder} disabled={props.disabled} /><InlineModelBrowser mode="models" selected={props.value ? [props.value] : []} onToggle={() => undefined} onSelectOne={props.onChange} /></div>; }
