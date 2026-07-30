/**
 * Shared "pick a provider / pick a model" experience — one picker instead of
 * three ad-hoc newline-separated textareas. Powers API key ACL fields
 * (allowed providers, allowed/denied models), combo model lists, and the
 * alias target field, so every surface that names a provider or model
 * behaves the same way: browse a catalog, or type one manually.
 */

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Boxes, Plus, Search, X } from "lucide-react";
import { apiGet } from "../lib/api";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input, Label } from "./ui/input";
import { ProviderIcon } from "./provider-icon";

interface ProviderSummary {
  id: string;
  name: string;
  icon: string;
  prefix: string;
  modelCount: number;
}

interface CatalogModel {
  id: string;
  enabled: boolean;
}

interface ProviderCatalogDetail {
  prefix: string;
  models: CatalogModel[];
}

interface ComboSummary {
  name: string;
}

interface FlatModelEntry {
  provider: ProviderSummary;
  qualified: string;
}

function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ items: ProviderSummary[] }>("/providers"),
    staleTime: 60_000,
  });
}

/** Flattens every provider's enabled models into one searchable list. Reuses
 * the same `["provider", id]` cache entries as the provider detail page —
 * visiting either populates the other. */
function useModelCatalog(providers: ProviderSummary[], enabled: boolean): FlatModelEntry[] {
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

function useCombos(enabled: boolean) {
  return useQuery({
    queryKey: ["console", "combos"],
    queryFn: () => apiGet<{ items: ComboSummary[] }>("/combos"),
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

/** Multi-value field: chips of the current list + a picker modal + a manual
 * fallback input, for lists a catalog can't fully cover (custom deployments,
 * not-yet-imported models). */
export function ModelPickerField({
  label,
  hint,
  values,
  onChange,
  mode,
  manualPlaceholder,
  disabled,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  mode: PickerMode;
  manualPlaceholder: string;
  disabled?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manual, setManual] = useState("");

  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  };
  const remove = (value: string) => onChange(values.filter((v) => v !== value));
  const addManual = () => {
    const trimmed = manual.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setManual("");
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => setPickerOpen(true)}>
          <Plus size={12} /> {mode === "providers" ? "Add provider" : "Add model"}
        </Button>
      </div>
      {hint && <p className="-mt-1 mb-1.5 text-[10.5px] text-[var(--text-3)]">{hint}</p>}
      {values.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-0.5 font-mono text-[10.5px] font-medium text-[var(--text-1)]"
            >
              {value}
              <button
                type="button"
                onClick={() => remove(value)}
                disabled={disabled}
                aria-label={`Remove ${value}`}
                className="text-[var(--text-3)] transition-colors hover:text-[var(--red)]"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder={manualPlaceholder}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addManual();
            }
          }}
        />
        <Button type="button" variant="secondary" size="sm" disabled={disabled || !manual.trim()} onClick={addManual}>
          Add
        </Button>
      </div>
      {pickerOpen && <ModelPickerModal open onClose={() => setPickerOpen(false)} mode={mode} selected={values} onToggle={toggle} />}
    </div>
  );
}

/** Single-value field for a model/combo target (alias target, sticky
 * defaults) — a plain text input (manual entry always works) plus a "Browse"
 * button that opens the same picker in single-select mode. */
export function ModelTargetPicker({
  value,
  onChange,
  placeholder,
  disabled,
  includeCombos = true,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  includeCombos?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="flex gap-1.5">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} className="flex-1" />
      <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => setPickerOpen(true)}>
        <Search size={12} /> Browse
      </Button>
      {pickerOpen && (
        <ModelPickerModal
          open
          onClose={() => setPickerOpen(false)}
          mode="models"
          selected={value ? [value] : []}
          onToggle={() => {}}
          onSelectOne={onChange}
          includeCombos={includeCombos}
          title="Select target model or combo"
        />
      )}
    </div>
  );
}
