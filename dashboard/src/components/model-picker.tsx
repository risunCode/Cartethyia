/**
 * Shared "pick a provider / pick a model" experience — one picker instead of
 * three ad-hoc newline-separated textareas. Powers API key ACL fields
 * (allowed providers, allowed/denied models), combo model lists, and the
 * alias target field, so every surface that names a provider or model
 * behaves the same way: browse a catalog, or type one manually.
 */

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Boxes, Search, X } from "lucide-react";
import { apiGet } from "../lib/api";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { Dialog } from "./ui/dialog";
import { Input, Label } from "./ui/input";
import { ProviderIcon } from "./provider-icon";

export interface ProviderSummary {
  id: string;
  name: string;
  icon: string;
  prefix: string;
  modelCount: number;
  connections: number;
}

interface CatalogModel {
  id: string;
  enabled: boolean;
}

interface ProviderCatalogDetail {
  prefix: string;
  models: CatalogModel[];
}

export interface ComboSummary {
  name: string;
}

export interface AliasSummary {
  alias: string;
  model: string;
}

export interface FlatModelEntry {
  provider: ProviderSummary;
  qualified: string;
}

export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ items: ProviderSummary[] }>("/providers"),
    staleTime: 60_000,
  });
}

/** Flattens every provider's enabled models into one searchable list. Reuses
 * the same `["provider", id]` cache entries as the provider detail page —
 * visiting either populates the other. */
export function useModelCatalog(providers: ProviderSummary[], enabled: boolean): FlatModelEntry[] {
  const results = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ["provider", provider.id],
      queryFn: () => apiGet<ProviderCatalogDetail>(`/providers/${provider.id}`),
      staleTime: 60_000,
      enabled,
    })),
  });
  return useMemo(() => {
    if (!enabled) return [];
    return providers.flatMap((provider, index) => {
      const detail = results[index]?.data;
      if (!detail) return [];
      return detail.models
        .filter((model) => model.enabled)
        .map((model) => ({ provider, qualified: `${detail.prefix}/${model.id}` }));
    });
    // `results` is a fresh array every render (useQueries), so depend on its
    // serialized data rather than the array reference to avoid a render loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, enabled, ...results.map((r) => r.dataUpdatedAt)]);
}

export function useCombos(enabled: boolean) {
  return useQuery({
    queryKey: ["console", "combos"],
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
    queryKey: ["console", "aliases"],
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
  const catalog = useModelCatalog(providers, open && mode === "models");
  const combosQuery = useCombos(open && mode === "models" && Boolean(includeCombos));
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
          {mode === "providers" ? (
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
function Section({ title, icon, accent, count, children }: { title: string; icon: React.ReactNode; accent?: boolean; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className={accent ? "text-[var(--accent)]" : "text-[var(--text-2)]"}>{icon}</span>
        <span className={`text-[11px] font-bold ${accent ? "text-[var(--accent)]" : "text-[var(--text-1)]"}`}>{title} ({count})</span>
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
  onSelectOne,
  includeCombos,
  includeAliases,
}: {
  mode: PickerMode;
  selected: string[];
  onToggle: (value: string) => void;
  onSelectOne?: (value: string) => void;
  includeCombos?: boolean;
  includeAliases?: boolean;
}) {
  const [search, setSearch] = useState("");

  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalog = useModelCatalog(providers, mode === "models");
  const combosQuery = useCombos(mode === "models" && Boolean(includeCombos));
  const aliasesQuery = useAliases(mode === "models" && Boolean(includeAliases));

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

  // Custom entries = selected items not in the catalog (manually added).
  const customEntries = useMemo(() => {
    const catalogSet = new Set(catalog.map((e) => e.qualified));
    return selected.filter((v) => !catalogSet.has(v));
  }, [selected, catalog]);

  // Group filtered models by provider.
  const grouped = useMemo(() => {
    const map = new Map<string, { icon: string; name: string; models: typeof filteredModels }>();
    for (const entry of filteredModels) {
      const existing = map.get(entry.provider.id);
      if (existing) {
        existing.models.push(entry);
      } else {
        map.set(entry.provider.id, { icon: entry.provider.icon, name: entry.provider.name, models: [entry] });
      }
    }
    return map;
  }, [filteredModels]);

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
        {mode === "providers" ? (
          filteredProviders.length === 0 ? (
            <div className="py-6 text-center text-[11px] text-[var(--text-3)]">No providers match.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {filteredProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => pick(provider.id)}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[11px] transition-colors hover:bg-[var(--surface)]"
                >
                  <ProviderIcon icon={provider.icon} name={provider.name} size={18} />
                  <span className="min-w-0 flex-1 truncate font-semibold text-[var(--text-1)]">{provider.name}</span>
                  {isSelected(provider.id) && <Badge tone="accent">✓</Badge>}
                </button>
              ))}
            </div>
          )
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
                      className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", isSelected(value) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}
                    >
                      <span className="min-w-0 flex-1 truncate">{value}</span>
                      {isSelected(value) && <span className="text-[var(--accent)]">✓</span>}
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
                        "inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]",
                        isSelected(entry.alias) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.alias}</span>
                      {isSelected(entry.alias) && <span className="text-[var(--accent)]">\u2713</span>}
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
                      className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", isSelected(combo.name) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}
                    >
                      <span className="min-w-0 flex-1 truncate">{combo.name}</span>
                      {isSelected(combo.name) && <span className="text-[var(--accent)]">✓</span>}
                    </button>
                  ))}
                </div>
              </Section>
            )}
            {/* Models grouped by provider */}
            {[...grouped.entries()].map(([providerId, { icon, name: providerName, models }]) => (
              <Section key={providerId} title={providerName} icon={<ProviderIcon icon={icon} name={providerName} size={13} />} count={models.length}>
                <div className="flex flex-wrap gap-1.5">
                  {models.map((entry) => (
                    <button
                      key={entry.qualified}
                      type="button"
                      onClick={() => pick(entry.qualified)}
                      className={cn("inline-flex items-center rounded-full border border-[var(--inner-border)] bg-[var(--surface)] px-2.5 py-1 text-[10.5px] font-mono transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", isSelected(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]")}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.qualified.split("/")[1]}</span>
                      {isSelected(entry.qualified) && <span className="text-[var(--accent)]">✓</span>}
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

/** Multi-value field: chips + inline catalog browser. */
export function ModelPickerField({
  label,
  hint,
  values,
  onChange,
  mode,
  disabled: _disabled,
  includeCombos,
  includeAliases,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  mode: PickerMode;
  manualPlaceholder?: string;
  disabled?: boolean;
  /** Combo/alias member lists (e.g. building a combo) must NOT set these - combo members are resolved without alias/combo indirection, so offering them there would produce a config that silently behaves differently than picked. */
  includeCombos?: boolean;
  includeAliases?: boolean;
}) {
  const remove = (value: string) => onChange(values.filter((v) => v !== value));
  const toggle = (value: string) =>
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);

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
      <InlineModelBrowser mode={mode} selected={values} onToggle={toggle} includeCombos={includeCombos} includeAliases={includeAliases} />
    </div>
  );
}

/** Single-value field: input + inline catalog browser (no modal). */
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
