import { Check, Route, Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ProviderIcon } from "./ProviderIcon";
import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { FlatModelCatalogEntry } from "../data/contracts";
import { UNKNOWN_LIMITS_TOOLTIP } from "../lib/format/tokens";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "../data/assert";

export type FlatModelEntry = FlatModelCatalogEntry;

export function useAllModelsCatalog(enabled: boolean): {
  items: FlatModelEntry[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = useQuery<FlatModelEntry[], ApiErrorShape>({
    queryKey: queryKeys.providers.flatAll,
    queryFn: (context) =>
      consoleRequest<FlatModelEntry[]>("/providers/models/flat", {
        signal: querySignal(context),
      }),
    enabled,
    staleTime: 0,
  });
  return {
    items: query.data ?? [],
    isLoading: query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

function formatShortTokens(value: number | null): string {
  if (value === null || value === undefined) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

function wireName(wireFamily: string): string {
  const lower = wireFamily.toLowerCase();
  if (lower === "responses") return "Responses";
  if (lower === "messages") return "Messages";
  return "Chat";
}

function wireColor(wireFamily: string): string {
  const lower = wireFamily.toLowerCase();
  if (lower === "responses") return "var(--purple)";
  if (lower === "messages") return "var(--orange)";
  return "var(--teal)";
}

/** Explains why a non-chat service model cannot be used from a chat surface. */
function NATIVE_SERVICE_TOOLTIP(serviceKind: string): string {
  if (serviceKind === "systemone") {
    return "System One decision model — not a chat model. Call it at POST /v1/systemone with {state, questions}; it answers {answers}. It cannot run in a chat playground.";
  }
  if (serviceKind === "websearch") {
    return "Web-search model — not a chat model. Call it at POST /v1/search with {query, max_results}; it answers a normalized list of hits. It cannot run in a chat playground.";
  }
  return `This model is served by a native '${serviceKind}' route, not the chat wire.`;
}

export function ModelPickerModal({
  open,
  onClose,
  selected,
  onToggle,
  onSelectOne,
  title = "Select model",
  multi = true,
  filter,
}: {
  open: boolean;
  onClose: () => void;
  selected: string[];
  onToggle: (value: string) => void;
  onSelectOne?: (value: string) => void;
  title?: string;
  multi?: boolean;
  /** Optional capability predicate (e.g. image-generation models only). */
  filter?: (entry: FlatModelEntry) => boolean;
}): ReactNode {
  const [search, setSearch] = useState("");
  const { items: catalog, isLoading, isError, refetch } = useAllModelsCatalog(open);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((e) => {
      if (filter && !filter(e)) return false;
      if (!q) return true;
      return (
        e.qualified.toLowerCase().includes(q) ||
        e.modelId.toLowerCase().includes(q) ||
        e.providerId.toLowerCase().includes(q)
      );
    });
  }, [catalog, search, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, FlatModelEntry[]>();
    for (const e of filtered) {
      // Aliases and combos have no owning provider: group them under their
      // own headings so they stay reachable next to the provider groups.
      const key = e.kind === "model" ? e.providerId : e.kind === "alias" ? "Aliases" : "Combos";
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    // Tenant-defined routing names first (aliases, then combos), then the
    // provider groups. Alphabetical sorting alone would scatter "Aliases" and
    // "Combos" between providers (e.g. after "claude", before "openai"), which
    // reads as if they were just another provider.
    const rank = (_key: string, entries: readonly FlatModelEntry[]): number => {
      const kind = entries[0]?.kind;
      if (kind === "alias") return 0;
      if (kind === "combo") return 1;
      return 2;
    };
    return Array.from(map.entries()).sort(([a, ea], [b, eb]) => {
      const ra = rank(a, ea);
      const rb = rank(b, eb);
      return ra !== rb ? ra - rb : a.localeCompare(b);
    });
  }, [filtered]);

  const isSelected = (q: string) => selected.includes(q);
  const handlePick = (q: string) => {
    if (onSelectOne && !multi) {
      onSelectOne(q);
      onClose();
    } else {
      onToggle(q);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} size="lg" footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="flex max-w-full flex-col gap-6">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-5 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models or providers (e.g. gpt-5.4, codex)"
            className="w-full max-w-full rounded-inset border border-inner-border bg-surface-2 py-4 pr-5 pl-16 text-caption text-text-primary"
          />
        </div>

        {multi && selected.length > 0 && (
          <div
            className="flex flex-wrap gap-3 rounded-inset border border-inner-border bg-surface-2 p-4"
          >
            {selected.map((s) => (
              <span key={s} className="font-mono tabular-nums inline-flex items-center gap-2 text-badge bg-accent-soft text-accent py-1 px-3 rounded-chip border border-accent max-w-full overflow-hidden break-all">
                <span
                  className="overflow-hidden truncate whitespace-nowrap"
                >
                  {s}
                </span>
                <button
                  type="button"
                  onClick={() => onToggle(s)}
                  className="bg-transparent border-none cursor-pointer p-0 flex shrink-0"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div
          className="flex min-h-160 max-h-210 flex-1 flex-col gap-8 overflow-x-hidden overflow-y-auto rounded-control border border-inner-border bg-surface-1 p-6"
        >
          {isLoading ? (
            <div
              className="p-16 text-center text-caption text-text-tertiary"
            >
              Loading catalog…
            </div>
          ) : isError ? (
            <div className="p-16 text-center text-caption">
              <p className="text-text-tertiary">Failed to load catalog.</p>
              <button type="button" onClick={refetch} className="mt-4">
                Retry
              </button>
            </div>
          ) : grouped.length === 0 ? (
            <div
              className="p-16 text-center text-caption text-text-tertiary"
            >
              No models found.
            </div>
          ) : (
            grouped.map(([groupKey, entries]) => {
              const isProviderGroup = entries[0]?.kind === "model";
              return (
              <div
                key={groupKey}
                className="flex flex-col gap-4 min-w-0"
              >
                <div
                  className="flex items-center gap-3 text-badge font-bold tracking-[0.05em] text-text-secondary uppercase"
                >
                  {isProviderGroup ? (
                    <ProviderIcon name={groupKey} icon={groupKey} size={16} />
                  ) : (
                    <Route size={14} />
                  )}
                  {groupKey}
                  <Badge tone="default">{entries.length}</Badge>
                </div>
                {/* Auto-fill so a group of two models does not stretch across the
                    whole panel; the 180px track is what a chip's model id needs. */}
                <div className="chip-grid grid min-w-0 gap-4">
                  {entries.map((e) => {
                    const sel = isSelected(e.qualified);
                    return (
                      <button
                        key={e.qualified}
                        type="button"
                        onClick={() => handlePick(e.qualified)}
                        className={`relative flex w-full min-w-0 cursor-pointer flex-col gap-2 overflow-hidden rounded-control px-6 py-5 text-left ${sel ? "border border-accent bg-accent-soft" : "border border-inner-border bg-surface-2"}`}
                      >
                        {sel && (
                          <Check
                            size={12}
                            className="absolute top-4 right-4 text-accent"
                          />
                        )}
                        <span
                          title={e.qualified}
                          className={`font-mono tabular-nums w-full overflow-hidden text-ellipsis whitespace-nowrap text-badge font-semibold ${sel ? "pr-8 text-accent" : "text-text-primary"}`}
                        >
                          {e.modelId}
                          {/* A non-chat service (System One) is not served on
                              the chat wire, so a chat playground cannot run it.
                              Label it here rather than let the operator pick it
                              and hit `capability_unsupported` on send. */}
                          {e.kind === "model" && e.entry.serviceKind !== "llm" && (
                            <span
                              title={NATIVE_SERVICE_TOOLTIP(e.entry.serviceKind)}
                              className="ml-3 inline-block cursor-help rounded-tiny border border-orange px-2.5 align-middle font-bold tracking-[0.04em] text-micro text-orange uppercase"
                            >
                              {e.entry.serviceKind}
                            </span>
                          )}
                        </span>
                        <span
                          title={e.qualified}
                          className="font-mono tabular-nums w-full truncate text-micro text-text-tertiary"
                        >
                          {/* An alias/combo is a named routing target, so its
                              target is the useful second line — not token
                              limits it does not have. */}
                          {e.kind === "alias" || e.kind === "combo" ? (
                            <span title={e.providerLabel}>{e.providerLabel}</span>
                          ) : (
                            <>
                              {e.entry.contextLimit ? (
                                `${formatShortTokens(e.entry.contextLimit)} ctx`
                              ) : (
                                <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
                                  n/a ctx
                                </span>
                              )}
                              {` · `}
                              {e.entry.outputLimit ? (
                                `${formatShortTokens(e.entry.outputLimit)} out`
                              ) : (
                                <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
                                  n/a out
                                </span>
                              )}
                          {" · "}
                          <span style={{ color: wireColor(e.entry.wireFamily), fontWeight: 700 }}>
                            {wireName(e.entry.wireFamily)}
                          </span>
                            </>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              );
            })
          )}
        </div>

      </div>
    </Dialog>
  );
}
