/**
 * Shared "pick a provider / pick a model" experience — one picker instead of
 * three ad-hoc newline-separated textareas. Powers API key ACL fields
 * (allowed providers, allowed/denied models), combo model lists, and the
 * alias target field, so every surface that names a provider or model
 * behaves the same way: browse a catalog, or type one manually.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Check, ChevronDown, Search } from "lucide-react";
import { daemonCatalog } from "../lib/daemon-api";
import { qk } from "../lib/query-keys";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { Dialog } from "./ui/dialog";
import { Input, Label } from "./ui/input";
import { ProviderIcon } from "./provider-icon";
import { Popout } from "../lib/popout";
export interface ProviderSummary {
  id: string;
  name: string;
  icon: string;
  prefix: string;
  modelCount: number;
  connections: number;
  models?: CatalogModel[];
  capabilityCounts?: {
    chat: number;
    media: number;
    websearch: number;
  };
  credentialKind?: "api_key" | "oauth" | "session" | "manual" | "none";
  credentialKinds?: Array<"api_key" | "oauth" | "session" | "manual" | "none">;
  enabled?: boolean;
  configured?: boolean;
}

interface CatalogModel {
  id?: string;
  modelId?: string;
  name?: string;
  enabled?: boolean;
  images?: boolean;
  capabilities?: {
    chat?: boolean;
    media?: boolean;
    imageGeneration?: boolean;
    videoGeneration?: boolean;
  };
}


export type ModelPickerCapability = "chat" | "image" | "video";

export interface ModelCapabilityFlags {
  chat: boolean;
  media: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
}

export interface FlatModelEntry {
  provider: ProviderSummary;
  qualified: string;
  capabilities: ModelCapabilityFlags;
}

export function useProviders() {
  return useQuery({
    queryKey: qk.catalog.providers,
    queryFn: async () => {
      const catalog = await daemonCatalog();
      return {
        items: catalog.map((provider) => ({
          id: provider.id,
          name: provider.name,
          icon: provider.id,
          prefix: provider.id,
          modelCount: provider.modelCount,
          connections: provider.accountCount,
          models: provider.models.map((model) => ({ id: model.id, enabled: model.enabled, capabilities: model.capabilities })),
          capabilityCounts: {
            chat: provider.models.filter((model) => model.enabled && model.capabilities.chat !== false).length,
            media: provider.models.filter((model) => model.enabled && model.capabilities.media === true).length,
            websearch: provider.models.filter((model) => model.enabled && model.capabilities.websearch === true).length,
          },
          credentialKind: provider.credentialKind === "unknown" ? "manual" : provider.credentialKind,
          credentialKinds: provider.credentialKind === "unknown" ? [] : [provider.credentialKind],
          enabled: provider.enabled,
          configured: provider.configured,
        })),
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** Flattens every provider's enabled models into one searchable list.
 * Catalog entries use a dedicated cache namespace so raw API responses from
 * the provider detail page cannot be mistaken for its normalized view. */
interface ModelCatalogState {
  items: FlatModelEntry[];
  isLoading: boolean;
  isError: boolean;
}

function canLoadCatalog(provider: ProviderSummary): boolean {
  return provider.credentialKind === "none" || provider.configured === true;
}
function modelCapabilityFlags(model: CatalogModel): ModelCapabilityFlags {
  const declared = model.capabilities;
  const imageGeneration = declared?.imageGeneration ?? declared?.media === true;
  const videoGeneration = declared?.videoGeneration === true;
  return {
    chat: declared?.chat ?? true,
    media: declared?.media ?? (imageGeneration || videoGeneration),
    imageGeneration,
    videoGeneration,
  };
}

export function useModelCatalogState(providers: ProviderSummary[], enabled: boolean): ModelCatalogState {
  const items = useMemo(() => {
    if (!enabled) return [];
    return providers.flatMap((provider) => {
      if (!canLoadCatalog(provider)) return [];
      return (provider.models ?? []).flatMap((model) => {
        const modelId = model.id ?? model.modelId;
        if (!modelId || model.enabled === false) return [];
        const qualified = modelId.startsWith(`${provider.prefix}/`) ? modelId : `${provider.prefix}/${modelId}`;
        return [{ provider, qualified, capabilities: modelCapabilityFlags(model) }];
      });
    });
  }, [providers, enabled]);

  return {
    items,
    isLoading: false,
    isError: false,
  };
}

export function useModelCatalog(providers: ProviderSummary[], enabled: boolean): FlatModelEntry[] {
  return useModelCatalogState(providers, enabled).items;
}

type PickerMode = "providers" | "models";


/**
 * Browse modal. In "providers" mode, rows are whole providers (for the
 * allowed-providers ACL). In "models" mode, rows are qualified `provider/model`
 * ids, searchable and filterable by provider, optionally alongside combo names.
 *
 * Pass `onSelectOne` for single-value pickers (alias target) — selecting a row
 * closes the modal instead of toggling membership in `selected`.
 */
export function ModelPickerModal({
  open,
  onClose,
  mode,
  selected,
  onToggle,
  onSelectOne,
  title,
}: {
  open: boolean;
  onClose: () => void;
  mode: PickerMode;
  selected: string[];
  onToggle: (value: string) => void;
  onSelectOne?: (value: string) => void;
  title?: string;
}) {
  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalogState = useModelCatalogState(providers, open && mode === "models");
  const catalog = catalogState.items;
  const catalogLoading = open && (providersQuery.isPending || catalogState.isLoading);
  const catalogError = open && ((mode === "providers" && providersQuery.isError) || (mode === "models" && catalogState.isError));
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string | null>(null);

  const isSelected = (value: string) => selected.includes(value);
  const pick = (value: string) => {
    if (onSelectOne) {
      onSelectOne(value);
      onClose();
    } else {
      onToggle(value);
    }
  };

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((entry) => {
      if (providerFilter && entry.provider.id !== providerFilter) return false;
      return !q || entry.qualified.toLowerCase().includes(q);
    });
  }, [catalog, search, providerFilter]);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((provider) => !q || provider.name.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q));
  }, [providers, search]);

  return (
    <Dialog open={open} onClose={onClose} title={title ?? (mode === "providers" ? "Add provider" : "Add model")} wide>
      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={mode === "providers" ? "Search providers…" : "Search models…"} className="pl-8" />
        </div>
        {mode === "models" && providers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setProviderFilter(null)} className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors", !providerFilter ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)]")}>All providers</button>
            {providers.map((provider) => (
              <button key={provider.id} type="button" onClick={() => setProviderFilter(provider.id === providerFilter ? null : provider.id)} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors", providerFilter === provider.id ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)]")}>
                <ProviderIcon icon={provider.icon} name={provider.name} size={14} className="rounded" />{provider.name}
              </button>
            ))}
          </div>
        )}
        <div className="max-h-80 overflow-y-auto rounded-xl border border-[var(--inner-border)]">
          {(mode === "providers" && providersQuery.isPending) || (mode === "models" && catalogLoading) ? (
            <div className="py-8 text-center text-xs text-[var(--text-3)]">Loading provider and model catalog…</div>
          ) : catalogError ? (
            <div className="py-8 text-center text-xs text-[var(--red)]">Unable to load provider and model catalog.</div>
          ) : mode === "providers" ? (
            filteredProviders.length === 0 ? <div className="py-8 text-center text-xs text-[var(--text-3)]">No providers match your search.</div> : filteredProviders.map((provider) => (
              <button key={provider.id} type="button" onClick={() => pick(provider.id)} className="flex w-full items-center gap-2.5 border-b border-[var(--inner-border)] px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--hover)]">
                <ProviderIcon icon={provider.icon} name={provider.name} size={22} />
                <div className="min-w-0 flex-1"><div className="font-semibold text-[var(--text-1)]">{provider.name}</div><div className="text-[10.5px] text-[var(--text-3)]">{provider.prefix} · {provider.modelCount} models</div></div>
                {isSelected(provider.id) && <Badge tone="accent">added</Badge>}
              </button>
            ))
          ) : (
            <>
              {filteredModels.map((entry) => (
                <button key={entry.qualified} type="button" onClick={() => pick(entry.qualified)} className="flex w-full items-center gap-2.5 border-b border-[var(--inner-border)] px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--hover)]">
                  <ProviderIcon icon={entry.provider.icon} name={entry.provider.name} size={22} />
                  <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold text-[var(--text-1)]">{entry.qualified}</div>
                  {isSelected(entry.qualified) && <Badge tone="accent">added</Badge>}
                </button>
              ))}
              {filteredModels.length === 0 && <div className="py-8 text-center text-xs text-[var(--text-3)]">No models match your search.</div>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
export function InlineModelBrowser({
  mode,
  selected,
  onToggle,
  onSelectOne,
}: {
  mode: PickerMode;
  selected: string[];
  onToggle: (value: string) => void;
  onSelectOne?: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalog = useModelCatalogState(providers, mode === "models").items;
  const query = search.trim().toLowerCase();
  const filteredProviders = providers.filter((provider) => !query || provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query));
  const filteredModels = catalog.filter((entry) => !query || entry.qualified.toLowerCase().includes(query));
  const pick = (value: string) => {
    if (onSelectOne) onSelectOne(value);
    else onToggle(value);
    setSearch("");
  };
  const addFromSearch = () => {
    const value = search.trim();
    if (!value || selected.includes(value)) return;
    onToggle(value);
    setSearch("");
  };
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={mode === "providers" ? "Search providers…" : "Search models…"} className="pl-8" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFromSearch(); } }} />
      </div>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
        {providersQuery.isPending ? <div className="py-6 text-center text-[11px] text-[var(--text-3)]">Loading provider catalog…</div> : mode === "providers" ? (
          <div className="flex flex-wrap gap-1.5">{filteredProviders.map((provider) => <button key={provider.id} type="button" onClick={() => pick(provider.id)} className="flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[11px] transition-colors hover:bg-[var(--surface-1)]"><ProviderIcon icon={provider.icon} name={provider.name} size={18} /><span className="truncate font-semibold text-[var(--text-1)]">{provider.name}</span></button>)}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">{filteredModels.map((entry) => <button key={entry.qualified} type="button" onClick={() => pick(entry.qualified)} className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", selected.includes(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}><ProviderIcon icon={entry.provider.icon} name={entry.provider.name} size={13} /><span className="truncate">{entry.qualified}</span></button>)}</div>
        )}
        {!providersQuery.isPending && mode === "models" && filteredModels.length === 0 && <div className="py-6 text-center text-[11px] text-[var(--text-3)]">No models match.</div>}
      </div>
    </div>
  );
}
export function ConfiguredModelPicker({
  value: valueProp,
  onChange,
  placeholder,
  capability,
  multiple = false,
  disabled = false,
}: {
  value: string | string[];
  onChange: ((value: string) => void) | ((values: string[]) => void);
  placeholder?: string;
  capability?: ModelPickerCapability;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const selectedValues = Array.isArray(valueProp) ? valueProp : [valueProp];
  const value = selectedValues[0] ?? "";
  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalog = useModelCatalogState(providers, true).items.filter((entry) => capability === undefined || (capability === "chat" ? entry.capabilities.chat : capability === "image" ? entry.capabilities.imageGeneration : entry.capabilities.videoGeneration));
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const grouped = new Map<string, { provider: ProviderSummary; models: FlatModelEntry[] }>();
    for (const entry of catalog) {
      if (query && !entry.qualified.toLowerCase().includes(query)) continue;
      const group = grouped.get(entry.provider.id);
      if (group) group.models.push(entry);
      else grouped.set(entry.provider.id, { provider: entry.provider, models: [entry] });
    }
    return [...grouped.values()];
  }, [catalog, query]);
  const selectValue = (nextValue: string) => {
    if (multiple) {
      const nextValues = selectedValues.includes(nextValue) ? selectedValues.filter((selectedValue) => selectedValue !== nextValue) : [...selectedValues, nextValue];
      (onChange as (values: string[]) => void)(nextValues);
    } else {
      (onChange as (selectedValue: string) => void)(nextValue);
      setOpen(false);
    }
  };
  const selectedProvider = providers.find((provider) => value.startsWith(`${provider.prefix}/`));
  return (
    <Popout open={open} onClose={() => setOpen(false)} width={400} preferUp matchTriggerWidth={false} panelClassName="model-picker-panel w-[min(400px,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-[var(--inner-border)] bg-[var(--popover-bg)] shadow-2xl"
      trigger={(ref) => <button ref={ref} type="button" onClick={() => setOpen((current) => !current)} disabled={disabled} className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 text-left text-[11.5px]" aria-expanded={open}>{selectedProvider ? <ProviderIcon icon={selectedProvider.icon} name={selectedProvider.name} size={15} /> : <Boxes size={14} className="shrink-0 text-[var(--text-3)]" />}<span className={cn("min-w-0 flex-1 truncate font-mono", selectedValues.length === 0 && "font-sans text-[var(--text-3)]")}>{multiple ? (selectedValues.length > 0 ? `${selectedValues.length} models selected` : placeholder || "Select configured models…") : (value || placeholder || "Select configured model…")}</span><ChevronDown size={12} /></button>}
      panel={() => <><div className="border-b border-[var(--inner-border)] p-2"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search configured models…" /></div><div className="h-[min(22rem,58vh)] overflow-y-auto p-1.5">{groups.length === 0 ? <div className="py-8 text-center text-[11px] text-[var(--text-3)]">No configured models match.</div> : groups.map(({ provider, models }) => <section key={provider.id} className="mb-2.5"><div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]"><ProviderIcon icon={provider.icon} name={provider.name} size={13} /><span>{provider.name}</span></div><div className="model-picker-grid">{models.map((entry) => <button key={entry.qualified} type="button" onClick={() => selectValue(entry.qualified)} className={cn("flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1.5 text-left", selectedValues.includes(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)]")}><span className="truncate font-mono text-[10px]">{entry.qualified.slice(entry.qualified.indexOf("/") + 1)}</span>{selectedValues.includes(entry.qualified) && <Check size={13} />}</button>)}</div></section>)}</div></>}
    />
  );
}

export function ModelPickerField({ label, hint, values, onChange, disabled = false }: { label: string; hint?: string; values: string[]; onChange: (values: string[]) => void; mode: PickerMode; disabled?: boolean }) {
  return <div><Label>{label}</Label>{hint && <p className="-mt-1 mb-1.5 text-[10.5px] text-[var(--text-3)]">{hint}</p>}<ConfiguredModelPicker value={values} multiple onChange={(nextValues: string | string[]) => onChange(Array.isArray(nextValues) ? nextValues : [nextValues])} disabled={disabled} placeholder="Add configured models…" /></div>;
}

export function ModelTargetPicker({ value, onChange, placeholder, disabled }: { value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) {
  return <div className="space-y-2"><Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} /><InlineModelBrowser mode="models" selected={value ? [value] : []} onToggle={() => undefined} onSelectOne={onChange} /></div>;
}
