/**
 * Shared "pick a provider / pick a model" experience — one picker instead of
 * three ad-hoc newline-separated textareas. Powers API key ACL fields
 * (allowed providers, allowed/denied models), combo model lists, and the
 * alias target field, so every surface that names a provider or model
 * behaves the same way: browse a catalog, or type one manually.
 */

import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Boxes, Check, ChevronDown, Search, X } from "lucide-react";
import { apiGet } from "../lib/api";
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
}

interface ProviderCatalogDetail {
  id?: string;
  prefix?: string;
  models: CatalogModel[];
}

export interface ComboSummary {
  name: string;
  models?: string[];
}

export interface AliasSummary {
  alias: string;
  model: string;
}

export interface FlatModelEntry {
  provider: ProviderSummary;
  qualified: string;
  images: boolean;
}

interface CustomProviderCatalogEntry {
  slug: string;
  name: string;
  models: Array<{ id?: string; modelId?: string } | string>;
  credentialHint?: string;
  enabled?: boolean;
}

/**
 * Custom OpenAI/Anthropic-compatible providers (Console \u2192 Providers \u2192
 * Custom) live in a separate table/endpoint from the built-in registry
 * (`custom_providers`, not `provider_registry`). The list endpoint already
 * embeds each provider's discovered `models`, so no per-id detail fetch is
 * needed here the way built-in providers require.
 */
export function useCustomProviders(enabled: boolean) {
  return useQuery({
    queryKey: qk.customProviders.all,
    queryFn: () => apiGet<{ items: CustomProviderCatalogEntry[] }>("/custom-providers"),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Flattens custom providers into the same `FlatModelEntry` shape built-in
 * providers use, so both sources merge into one searchable/groupable list.
 * Regression: this catalog was previously never fetched at all \u2014 a custom
 * (BYOK) provider's models could never be picked for an API key's
 * allowed/denied model list, only typed in manually.
 */
export function useCustomProviderCatalog(customProviders: CustomProviderCatalogEntry[]): FlatModelEntry[] {
  return useMemo(
    () =>
      customProviders.filter((provider) => provider.enabled !== false && (provider.credentialHint === undefined || provider.credentialHint.length > 0)).flatMap((provider) => {
        const summary: ProviderSummary = {
          id: `custom:${provider.slug}`,
          name: provider.name,
          icon: provider.slug,
          prefix: provider.slug,
          modelCount: provider.models.length,
          connections: 0,
        };
        return provider.models.flatMap((model) => {
          const modelId = typeof model === "string" ? model : model.id ?? model.modelId;
          if (!modelId) return [];
          // Avoid double-prefixing when modelId already starts with the slug.
          const qualified = modelId.startsWith(`${provider.slug}/`) ? modelId : `${provider.slug}/${modelId}`;
          return [{ provider: summary, qualified, images: false }];
        });
      }),
    [customProviders]
  );
}

export function useProviders() {
  return useQuery({
    queryKey: qk.catalog.providers,
    queryFn: async () => {
      const response = await apiGet<{ items: Array<ProviderSummary & { icon?: string; prefix?: string; accountCount?: number; modelCount?: number }> }>("/providers");
      return {
        items: response.items.map((provider) => ({
          ...provider,
          icon: provider.icon ?? provider.id,
          prefix: provider.prefix ?? provider.id,
          modelCount: provider.modelCount ?? 0,
          connections: provider.connections ?? provider.accountCount ?? 0,
        })),
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 2,
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

export function useModelCatalogState(providers: ProviderSummary[], enabled: boolean): ModelCatalogState {
  const results = useQueries({
    queries: providers.map((provider) => ({
      queryKey: qk.catalog.provider(provider.id),
      queryFn: () => apiGet<ProviderCatalogDetail>(`/providers/${encodeURIComponent(provider.id)}`),
      staleTime: 60_000,
      enabled: enabled && canLoadCatalog(provider),
    })),
  });
  const resultVersion = results.map((result) => `${result.dataUpdatedAt}:${result.status}:${result.fetchStatus}`).join("|");

  const items = useMemo(() => {
    if (!enabled) return [];
    return providers.flatMap((provider, index) => {
      if (!canLoadCatalog(provider)) return [];
      const detail = results[index]?.data;
      if (!detail || !Array.isArray(detail.models)) return [];
      return detail.models.flatMap((model) => {
        const modelId = model.id ?? model.modelId;
        if (!modelId || model.enabled === false) return [];
        const prefix = detail.prefix ?? provider.prefix;
        // Avoid double-prefixing: some providers (e.g. Blackbox) return model
        // IDs that already include the provider prefix (e.g. "blackboxai/z-ai/glm-5.2").
        // If modelId starts with `${prefix}/`, use it as-is.
        const qualified = modelId.startsWith(`${prefix}/`) ? modelId : `${prefix}/${modelId}`;
        return [{ provider, qualified, images: model.images === true }];
      });
    });
    // `results` is a fresh array every render (useQueries), so depend on its
    // serialized data rather than the array reference to avoid a render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, enabled, resultVersion]);

  const eligibleResults = results.filter((_result, index) => {
    const provider = providers[index];
    return provider !== undefined && canLoadCatalog(provider);
  });
  return {
    items,
    isLoading: enabled && eligibleResults.some((result) => result.isPending),
    isError: enabled && eligibleResults.some((result) => result.isError),
  };
}

export function useModelCatalog(providers: ProviderSummary[], enabled: boolean): FlatModelEntry[] {
  return useModelCatalogState(providers, enabled).items;
}

export function useCombos(enabled: boolean) {
  return useQuery({
    queryKey: qk.combos.all,
    queryFn: () => apiGet<{ items: ComboSummary[] }>("/combos"),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * An alias resolves (bare, no provider prefix) exactly like a combo does -
 * `resolveModelChain` checks qualified prefix, then `resolveAlias(name)`,
 * then combo - so an alias's own name is a valid value anywhere a
 * `provider/model` or combo name is (API key allow/deny lists, another
 * alias's target). It was previously only addable by typing it manually;
 * this exposes it as a browsable/fetchable catalog entry too.
 */
export function useAliases(enabled: boolean) {
  return useQuery({
    queryKey: qk.aliases.all,
    queryFn: () => apiGet<{ items: AliasSummary[] }>("/aliases"),
    staleTime: 60_000,
    enabled,
  });
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
  includeCombos,
  title,
}: {
  open: boolean;
  onClose: () => void;
  mode: PickerMode;
  selected: string[];
  onToggle: (value: string) => void;
  onSelectOne?: (value: string) => void;
  includeCombos?: boolean;
  title?: string;
}) {
  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalogState = useModelCatalogState(providers, open && mode === "models");
  const catalog = catalogState.items;
  const combosQuery = useCombos(open && mode === "models" && Boolean(includeCombos));
  const catalogLoading = open && (
    providersQuery.isPending ||
    catalogState.isLoading ||
    (Boolean(includeCombos) && combosQuery.isPending)
  );
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

  const filteredCombos = useMemo(() => {
    if (!includeCombos) return [];
    const q = search.trim().toLowerCase();
    return (combosQuery.data?.items ?? []).filter((combo) => !q || combo.name.toLowerCase().includes(q));
  }, [combosQuery.data, search, includeCombos]);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((provider) => !q || provider.name.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q));
  }, [providers, search]);

  return (
    <Dialog open={open} onClose={onClose} title={title ?? (mode === "providers" ? "Add provider" : "Add model")} wide>
      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={mode === "providers" ? "Search providers…" : "Search models…"}
            className="pl-8"
          />
        </div>

        {mode === "models" && providers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setProviderFilter(null)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                !providerFilter
                  ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)]"
              )}
            >
              All providers
            </button>
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => setProviderFilter(provider.id === providerFilter ? null : provider.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                  providerFilter === provider.id
                    ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)]"
                )}
              >
                <ProviderIcon icon={provider.icon} name={provider.name} size={14} className="rounded" />
                {provider.name}
              </button>
            ))}
          </div>
        )}

        <div className="max-h-80 overflow-y-auto rounded-xl border border-[var(--inner-border)]">
          {(mode === "providers" && providersQuery.isPending) || (mode === "models" && catalogLoading) ? (
            <div className="py-8 text-center text-xs text-[var(--text-3)]">Loading provider and model catalog…</div>
          ) : mode === "providers" ? (
            filteredProviders.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--text-3)]">No providers match your search.</div>
            ) : (
              filteredProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => pick(provider.id)}
                  className="flex w-full items-center gap-2.5 border-b border-[var(--inner-border)] px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--hover)]"
                >
                  <ProviderIcon icon={provider.icon} name={provider.name} size={22} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[var(--text-1)]">{provider.name}</div>
                    <div className="text-[10.5px] text-[var(--text-3)]">{provider.prefix} · {provider.modelCount} models</div>
                  </div>
                  {isSelected(provider.id) && <Badge tone="accent">added</Badge>}
                </button>
              ))
            )
          ) : (
            <>
              {includeCombos &&
                filteredCombos.map((combo) => (
                  <button
                    key={`combo:${combo.name}`}
                    type="button"
                    onClick={() => pick(combo.name)}
                    className="flex w-full items-center gap-2.5 border-b border-[var(--inner-border)] px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--hover)]"
                  >
                    <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[8px] bg-[var(--accent-soft)] text-[var(--accent)]">
                      <Boxes size={12} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11.5px] font-semibold text-[var(--text-1)]">{combo.name}</div>
                      <div className="text-[10.5px] text-[var(--text-3)]">Combo</div>
                    </div>
                    {isSelected(combo.name) && <Badge tone="accent">added</Badge>}
                  </button>
                ))}
              {filteredModels.map((entry) => (
                <button
                  key={entry.qualified}
                  type="button"
                  onClick={() => pick(entry.qualified)}
                  className="flex w-full items-center gap-2.5 border-b border-[var(--inner-border)] px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-[var(--hover)]"
                >
                  <ProviderIcon icon={entry.provider.icon} name={entry.provider.name} size={22} />
                  <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold text-[var(--text-1)]">{entry.qualified}</div>
                  {isSelected(entry.qualified) && <Badge tone="accent">added</Badge>}
                </button>
              ))}
              {filteredModels.length === 0 && filteredCombos.length === 0 && (
                <div className="py-8 text-center text-xs text-[var(--text-3)]">No models match your search.</div>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Section header + grid wrapper for grouped models. */
function Section({ title, icon, accent, count, children, onSelectAll, allSelected }: { title: string; icon: React.ReactNode; accent?: boolean; count: number; children: React.ReactNode; onSelectAll?: () => void; allSelected?: boolean }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className={accent ? "text-[var(--accent)]" : "text-[var(--text-2)]"}>{icon}</span>
        {onSelectAll ? (
          <button type="button" onClick={onSelectAll} className={cn("text-[11px] font-bold transition-colors hover:text-[var(--accent)]", allSelected ? "text-[var(--accent)]" : accent ? "text-[var(--accent)]" : "text-[var(--text-1)]")} title={allSelected ? `Deselect all ${title} models` : `Select all ${title} models`}>{title} ({count})</button>
        ) : <span className={`text-[11px] font-bold ${accent ? "text-[var(--accent)]" : "text-[var(--text-1)]"}`}>{title} ({count})</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * Inline catalog browser — search + provider pills + model/provider list.
 * Embeds directly in forms; no nested modal.
 */
export function InlineModelBrowser({
  mode,
  selected,
  onToggle,
  onChange,
  onSelectOne,
  includeCombos,
  includeAliases,
}: {
  mode: PickerMode;
  selected: string[];
  onToggle: (value: string) => void;
  onChange?: (values: string[]) => void;
  onSelectOne?: (value: string) => void;
  includeCombos?: boolean;
  includeAliases?: boolean;
}) {
  const [search, setSearch] = useState("");

  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const builtinCatalogState = useModelCatalogState(providers, mode === "models");
  const builtinCatalog = builtinCatalogState.items;
  const customProvidersQuery = useCustomProviders(mode === "models");
  const customCatalog = useCustomProviderCatalog(customProvidersQuery.data?.items ?? []);
  const catalog = useMemo(() => [...builtinCatalog, ...customCatalog], [builtinCatalog, customCatalog]);
  const combosQuery = useCombos(mode === "models" && Boolean(includeCombos));
  const aliasesQuery = useAliases(mode === "models" && Boolean(includeAliases));
  const catalogLoading = mode === "models" && (
    providersQuery.isPending ||
    customProvidersQuery.isPending ||
    builtinCatalogState.isLoading ||
    (Boolean(includeCombos) && combosQuery.isPending) ||
    (Boolean(includeAliases) && aliasesQuery.isPending)
  );

  const pick = (value: string) => {
    if (onSelectOne) {
      onSelectOne(value);
    } else {
      onToggle(value);
    }
    setSearch("");
  };

  const addFromSearch = () => {
    const trimmed = search.trim();
    if (!trimmed || selected.includes(trimmed)) return;
    onToggle(trimmed);
    setSearch("");
  };

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((entry) => !q || entry.qualified.toLowerCase().includes(q));
  }, [catalog, search]);

  const filteredCombos = useMemo(() => {
    if (!includeCombos) return [];
    const q = search.trim().toLowerCase();
    return (combosQuery.data?.items ?? []).filter((combo) => !q || combo.name.toLowerCase().includes(q));
  }, [combosQuery.data, search, includeCombos]);

  const filteredAliases = useMemo(() => {
    if (!includeAliases) return [];
    const q = search.trim().toLowerCase();
    return (aliasesQuery.data?.items ?? []).filter((entry) => !q || entry.alias.toLowerCase().includes(q));
  }, [aliasesQuery.data, search, includeAliases]);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [providers, search]);

  const isSelected = (value: string) => selected.includes(value);

  // Custom entries = selected items not represented anywhere else — not in
  // the model catalog, and not an alias/combo name (those already render in
  // their own sections below; counting them here too duplicated every
  // selected alias/combo under a spurious "Custom" group).
  const customEntries = useMemo(() => {
    const catalogSet = new Set(catalog.map((e) => e.qualified));
    const aliasSet = new Set(includeAliases ? (aliasesQuery.data?.items ?? []).map((entry) => entry.alias) : []);
    const comboSet = new Set(includeCombos ? (combosQuery.data?.items ?? []).map((combo) => combo.name) : []);
    return selected.filter((v) => !catalogSet.has(v) && !aliasSet.has(v) && !comboSet.has(v));
  }, [selected, catalog, includeAliases, aliasesQuery.data, includeCombos, combosQuery.data]);

  // Group filtered models by provider, keeping custom (BYOK) providers in
  // their own map so they can render as their own section right after
  // Aliases/Combos instead of wherever they land in provider-list order
  // (they were previously appended to the end of the flattened catalog, so
  // they'd sort dead last, after every built-in provider).
  const groupModels = (entries: typeof filteredModels) => {
    const map = new Map<string, { icon: string; name: string; models: typeof filteredModels }>();
    for (const entry of entries) {
      const existing = map.get(entry.provider.id);
      if (existing) {
        existing.models.push(entry);
      } else {
        map.set(entry.provider.id, { icon: entry.provider.icon, name: entry.provider.name, models: [entry] });
      }
    }
    return map;
  };
  const groupedCustom = useMemo(() => groupModels(filteredModels.filter((e) => e.provider.id.startsWith("custom:"))), [filteredModels]);
  const groupedBuiltin = useMemo(() => groupModels(filteredModels.filter((e) => !e.provider.id.startsWith("custom:"))), [filteredModels]);

  const toggleGroup = (values: string[]) => {
    const allSelected = values.length > 0 && values.every((value) => selected.includes(value));
    const next = allSelected ? selected.filter((value) => !values.includes(value)) : [...selected, ...values.filter((value) => !selected.includes(value))];
    if (onChange) onChange(next);
    else for (const value of values) onToggle(value);
  };
  const matchesSearch = (value: string) => {
    const q = search.trim().toLowerCase();
    return !q || value.toLowerCase().includes(q);
  };

  const filteredCustom = customEntries.filter(matchesSearch);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={mode === "providers" ? "Search providers…" : "Search models…"}
          className="pl-8"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFromSearch();
            }
          }}
        />
        {search.trim() && !selected.includes(search.trim()) && (
          <button
            type="button"
            onClick={addFromSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--accent)] hover:text-white"
          >
            + Add "{search.trim()}"
          </button>
        )}
      </div>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
        {mode === "providers" && providersQuery.isPending ? (
          <div className="py-6 text-center text-[11px] text-[var(--text-3)]">Loading provider catalog…</div>
        ) : mode === "providers" ? (
          filteredProviders.length === 0 ? (
            <div className="py-6 text-center text-[11px] text-[var(--text-3)]">No providers match.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {filteredProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => pick(provider.id)}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[11px] transition-colors hover:bg-[var(--surface-1)]"
                >
                  <ProviderIcon icon={provider.icon} name={provider.name} size={18} />
                  <span className="min-w-0 flex-1 truncate font-semibold text-[var(--text-1)]">{provider.name}</span>

                </button>
              ))}
            </div>
          )
        ) : catalogLoading ? (
          <div className="py-6 text-center text-[11px] text-[var(--text-3)]">Loading provider and model catalog…</div>
        ) : (
          <>
            {/* Custom entries */}
            {filteredCustom.length > 0 && (
              <Section title="Custom" icon={<Boxes size={13} />} accent count={filteredCustom.length}>
                <div className="flex flex-wrap gap-1.5">
                  {filteredCustom.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => pick(value)}
                      className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", isSelected(value) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}
                    >
                      <span className="min-w-0 flex-1 truncate">{value}</span>

                    </button>
                  ))}
                </div>
              </Section>
            )}
            {/* Aliases - shown above Combos and per-provider models */}
            {includeAliases && filteredAliases.length > 0 && (
              <Section title="Aliases" icon={<Boxes size={13} />} accent count={filteredAliases.length}>
                <div className="flex flex-wrap gap-1.5">
                  {filteredAliases.map((entry) => (
                    <button
                      key={`alias:${entry.alias}`}
                      type="button"
                      onClick={() => pick(entry.alias)}
                      title={`\u2192 ${entry.model}`}
                      className={cn(
                        "inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]",
                        isSelected(entry.alias) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate"><span className="block">{entry.alias}</span><span className="block truncate text-[9px] text-[var(--text-3)]">→ {entry.model}</span></span>

                    </button>
                  ))}
                </div>
              </Section>
            )}
            {/* Combos */}
            {includeCombos && filteredCombos.length > 0 && (
              <Section title="Combos" icon={<Boxes size={13} />} accent count={filteredCombos.length}>
                <div className="flex flex-wrap gap-1.5">
                  {filteredCombos.map((combo) => (
                    <button
                      key={`combo:${combo.name}`}
                      type="button"
                      onClick={() => pick(combo.name)}
                      className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", isSelected(combo.name) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}
                    >
                      <span className="min-w-0 flex-1 truncate">{combo.name}</span>

                    </button>
                  ))}
                </div>
              </Section>
            )}
            {/* Custom (BYOK) providers \u2014 right after Aliases/Combos, ahead of
                every built-in provider group. */}
            {[...groupedCustom.entries()].map(([providerId, { icon, name: providerName, models }]) => (
              <Section key={providerId} title={providerName} icon={<ProviderIcon icon={icon} name={providerName} size={13} />} count={models.length} onSelectAll={() => toggleGroup(models.map((entry) => entry.qualified))} allSelected={models.length > 0 && models.every((entry) => selected.includes(entry.qualified))}>
                <div className="flex flex-wrap gap-1.5">
                  {models.map((entry) => (
                    <button
                      key={entry.qualified}
                      type="button"
                      onClick={() => pick(entry.qualified)}
                      className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", isSelected(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.qualified.slice(entry.qualified.indexOf("/") + 1)}</span>

                    </button>
                  ))}
                </div>
              </Section>
            ))}
            {/* Built-in providers, grouped */}
            {[...groupedBuiltin.entries()].map(([providerId, { icon, name: providerName, models }]) => (
              <Section key={providerId} title={providerName} icon={<ProviderIcon icon={icon} name={providerName} size={13} />} count={models.length} onSelectAll={() => toggleGroup(models.map((entry) => entry.qualified))} allSelected={models.length > 0 && models.every((entry) => selected.includes(entry.qualified))}>
                <div className="flex flex-wrap gap-1.5">
                  {models.map((entry) => (
                    <button
                      key={entry.qualified}
                      type="button"
                      onClick={() => pick(entry.qualified)}
                      className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", isSelected(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}
                    >
                      {/* Everything after the FIRST slash, not `.split("/")[1]` \u2014 some
                          providers' own model ids embed a slash (OpenRouter's
                          "owner/model" convention), so `qualified` can have
                          two: `openrouter/anthropic/claude-3-opus`. Taking
                          just index [1] silently truncated to the owner
                          segment ("anthropic") for every such model. */}
                      <span className="min-w-0 flex-1 truncate">{entry.qualified.slice(entry.qualified.indexOf("/") + 1)}</span>

                    </button>
                  ))}
                </div>
              </Section>
            ))}
            {filteredModels.length === 0 && filteredCombos.length === 0 && filteredAliases.length === 0 && filteredCustom.length === 0 && (
              <div className="py-6 text-center text-[11px] text-[var(--text-3)]">No models match.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
/** Compact picker used by setup flows; it only exposes models from configured providers. */
export function ConfiguredModelPicker({
  value: valueProp,
  onChange,
  placeholder,
  includeCombos = false,
  includeAliases = false,
  onCapabilityChange,
  multiple = false,
  disabled = false,
  includeCustomProviders = true,
}: {
  value: string | string[];
  onChange: ((value: string) => void) | ((values: string[]) => void);
  placeholder?: string;
  includeCombos?: boolean;
  includeAliases?: boolean;
  includeCustomProviders?: boolean;
  onCapabilityChange?: (images: boolean) => void;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const selectedValues = Array.isArray(valueProp) ? valueProp : [valueProp];
  const value = selectedValues[0] ?? "";
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalogState = useModelCatalogState(providers, open || Boolean(value));
  const customProvidersQuery = useCustomProviders(includeCustomProviders && (open || Boolean(value)));
  const customCatalog = includeCustomProviders ? useCustomProviderCatalog(customProvidersQuery.data?.items ?? []) : [];
  const combosQuery = useCombos(open && includeCombos);
  const aliasesQuery = useAliases(open && includeAliases);
  const query = search.trim().toLowerCase();
  const catalog = useMemo(() => [...catalogState.items, ...customCatalog], [catalogState.items, customCatalog]);
  useEffect(() => {
    const selected = catalog.find((entry) => entry.qualified === value);
    onCapabilityChange?.(selected?.images === true);
  }, [catalog, onCapabilityChange, value]);
  const groups = useMemo(() => {
    const map = new Map<string, { provider: ProviderSummary; models: FlatModelEntry[] }>();
    for (const entry of catalog) {
      if (query && !entry.qualified.toLowerCase().includes(query)) continue;
      const group = map.get(entry.provider.id);
      if (group) group.models.push(entry);
      else map.set(entry.provider.id, { provider: entry.provider, models: [entry] });
    }
    return [...map.values()];
  }, [catalog, query]);
  const selectValue = (nextValue: string) => {
    if (multiple) {
      const nextValues = selectedValues.includes(nextValue)
        ? selectedValues.filter((selectedValue) => selectedValue !== nextValue)
        : [...selectedValues, nextValue];
      (onChange as (values: string[]) => void)(nextValues);
      return;
    }
    (onChange as (selectedValue: string) => void)(nextValue);
    setOpen(false);
  };
  const selectedProvider = providers.find((provider) => value.startsWith(`${provider.prefix}/`));
  const loading = open && (providersQuery.isPending || (includeCustomProviders && customProvidersQuery.isPending) || catalogState.isLoading || (includeCombos && combosQuery.isPending) || (includeAliases && aliasesQuery.isPending));
  const filteredCombos = useMemo(() => (includeCombos ? (combosQuery.data?.items ?? []).filter((combo) => !query || combo.name.toLowerCase().includes(query)) : []), [combosQuery.data, includeCombos, query]);
  const filteredAliases = useMemo(() => (includeAliases ? (aliasesQuery.data?.items ?? []).filter((alias) => !query || alias.alias.toLowerCase().includes(query)) : []), [aliasesQuery.data, includeAliases, query]);
  return (
    <Popout
      open={open}
      onClose={() => setOpen(false)}
      width={400}
      preferUp
      matchTriggerWidth={false}
      panelClassName="model-picker-panel w-[min(400px,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-[var(--inner-border)] bg-[var(--popover-bg)] shadow-2xl"

      trigger={(ref) => (
        <button ref={ref} type="button" onClick={() => setOpen((current) => !current)} disabled={disabled} className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 text-left text-[11.5px] transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50" aria-expanded={open}>
          {selectedProvider ? <ProviderIcon icon={selectedProvider.icon} name={selectedProvider.name} size={15} /> : <Boxes size={14} className="shrink-0 text-[var(--text-3)]" />}
          <span className={cn("min-w-0 flex-1 truncate font-mono", selectedValues.length === 0 && "font-sans text-[var(--text-3)]")}>{multiple ? (selectedValues.length > 0 ? `${selectedValues.length} models selected` : placeholder || "Select configured models…") : (value || placeholder || "Select configured model…")}</span>
          <ChevronDown size={12} className={cn("shrink-0 text-[var(--text-3)] transition-transform", open && "rotate-180")} />
        </button>
      )}
      panel={() => (
        <>
          <div className="border-b border-[var(--inner-border)] p-2">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search configured models…" className="w-full rounded-lg border-none bg-[var(--surface-1)] py-1.5 pl-8 pr-2.5 text-[12px] outline-none placeholder:text-[var(--text-3)]" />
            </div>
          </div>
          <div className="h-[min(22rem,58vh)] overflow-y-auto overscroll-contain p-1.5">
            {loading ? (
              <div className="py-8 text-center text-[11px] text-[var(--text-3)]">Loading configured models…</div>
            ) : filteredAliases.length === 0 && filteredCombos.length === 0 && groups.length === 0 ? (
              <div className="py-8 text-center text-[11px] text-[var(--text-3)]">No configured models match.</div>
            ) : (
              <>
                {filteredAliases.length > 0 && (
                  <section className="mb-2.5">
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]"><Boxes size={13} /> Aliases</div>
                    <div className="model-picker-grid">
                      {filteredAliases.map((alias) => (
                        <button key={alias.alias} type="button" onClick={() => selectValue(alias.alias)} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"><Boxes size={12} /></span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold">{alias.alias}</span>
                          {selectedValues.includes(alias.alias) && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {filteredCombos.length > 0 && (
                  <section className="mb-2.5">
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]"><Boxes size={13} /> Combos</div>
                    <div className="model-picker-grid">
                      {filteredCombos.map((combo) => (
                        <button key={combo.name} type="button" onClick={() => selectValue(combo.name)} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"><Boxes size={12} /></span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold">{combo.name}</span>
                          {selectedValues.includes(combo.name) && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {groups.map(({ provider, models }) => (
                  <section key={provider.id} className="mb-2.5 last:mb-0">
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]">
                      <ProviderIcon icon={provider.icon} name={provider.name} size={13} className="rounded" />
                      <span className="truncate">{provider.name}</span>
                      <span className="ml-auto text-[9px] font-medium normal-case tracking-normal">{models.length}</span>
                    </div>
                    <div className="model-picker-grid">
                      {models.map((entry) => (
                        <button key={entry.qualified} type="button" onClick={() => selectValue(entry.qualified)} className={cn("group flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", selectedValues.includes(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)]")}>
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--surface-1)] text-[var(--accent)]"><ProviderIcon icon={entry.provider.icon} name={entry.provider.name} size={14} className="rounded" /></span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold text-[var(--text-1)]" title={entry.qualified}>{entry.qualified.slice(entry.qualified.indexOf("/") + 1)}</span>
                          {selectedValues.includes(entry.qualified) && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </>
            )}
          </div>
        </>
      )}
    />
  );
}

/** Multi-value field: chips + inline catalog browser. */
export function ModelPickerField({
  label,
  hint,
  values,
  onChange,
  mode: _mode,
  disabled: _disabled,
  includeCombos,
  includeAliases,
  includeCustomProviders = true,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  mode: PickerMode;
  manualPlaceholder?: string;
  disabled?: boolean;
  /** Combo/alias member lists (e.g. building a combo) must NOT set these - combo members are resolved without alias/combo indirection, so offering them there would produce a config that silently behaves differently from picked. */
  includeCombos?: boolean;
  includeAliases?: boolean;
  /** API-key ACLs keep custom BYOK providers separate from built-in providers. */
  includeCustomProviders?: boolean;
}) {
  const remove = (value: string) => onChange(values.filter((current) => current !== value));
  const [compatSearch, setCompatSearch] = useState("");
  const addCompatValue = () => {
    const nextValue = compatSearch.trim();
    if (!nextValue || values.includes(nextValue)) return;
    onChange([...values, nextValue]);
    setCompatSearch("");
  };
  return (
    <div>
      <Label>{label}</Label>
      {hint && <p className="-mt-1 mb-1.5 text-[10.5px] text-[var(--text-3)]">{hint}</p>}
      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-0.5 font-mono text-[10.5px] font-medium text-[var(--text-1)]"
            >
              <span className="truncate">{value}</span>
              <button
                type="button"
                onClick={() => remove(value)}
                disabled={_disabled}
                aria-label={`Remove ${value}`}
                className="text-[var(--text-3)] transition-colors hover:text-[var(--red)]"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="sr-only">
        <input placeholder="Search models…" value={compatSearch} onChange={(event) => setCompatSearch(event.target.value)} />
        {compatSearch.trim() && <button type="button" onClick={addCompatValue}>Add "{compatSearch.trim()}"</button>}
      </div>
      <ConfiguredModelPicker
        value={values}
        multiple
        onChange={(nextValues: string | string[]) => onChange(nextValues as string[])}
        includeCombos={includeCombos}
        includeAliases={includeAliases}
        includeCustomProviders={includeCustomProviders}
        placeholder="Add configured models…"
        disabled={_disabled}
      />
    </div>
  );
}

/** Single-value field: input + inline catalog browser. */
export function ModelTargetPicker({
  value,
  onChange,
  placeholder,
  disabled,
  includeCombos = true,
  includeAliases = true,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  includeCombos?: boolean;
  includeAliases?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />
      <InlineModelBrowser
        mode="models"
        selected={value ? [value] : []}
        onToggle={() => {}}
        onSelectOne={onChange}
        includeCombos={includeCombos}
        includeAliases={includeAliases}
      />
    </div>
  );
}
