import { Check, Route, Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ProviderIcon } from "./ProviderIcon";
import { consoleRequest } from "../lib/api";
import type { ApiErrorShape } from "../lib/api";
import type { FlatModelCatalogEntry } from "../lib/contracts";
import { UNKNOWN_LIMITS_TOOLTIP } from "../lib/model-limits";
import { queryKeys } from "../lib/query-keys";
import { querySignal } from "../lib/hooks/common";

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
  if (lower === "native") return "Native";
  return "Chat";
}

function wireColor(wireFamily: string): string {
  const lower = wireFamily.toLowerCase();
  if (lower === "responses") return "var(--purple)";
  if (lower === "messages") return "var(--orange)";
  if (lower === "native") return "var(--text-tertiary)";
  return "var(--teal)";
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
    <Dialog open={open} onClose={onClose} title={title}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          width: "min(720px, 90vw)",
          maxHeight: "70vh",
          maxWidth: "100%",
        }}
      >
        <div style={{ position: "relative" }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: "10px",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-tertiary)",
            }}
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models or providers (e.g. gpt-5.4, codex)"
            style={{
              width: "100%",
              maxWidth: "100%",
              boxSizing: "border-box",
              padding: "8px 10px 8px 32px",
              borderRadius: "8px",
              border: "1px solid var(--inner-border)",
              background: "var(--surface-2)",
              color: "var(--text-primary)",
              fontSize: "12px",
            }}
          />
        </div>

        {multi && selected.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              padding: "8px",
              borderRadius: "8px",
              background: "var(--surface-2)",
              border: "1px solid var(--inner-border)",
            }}
          >
            {selected.map((s) => (
              <span
                key={s}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  padding: "2px 6px",
                  borderRadius: "6px",
                  border: "1px solid var(--accent)",
                  maxWidth: "100%",
                  overflow: "hidden",
                  wordBreak: "break-all",
                }}
              >
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {s}
                </span>
                <button
                  type="button"
                  onClick={() => onToggle(s)}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    display: "flex",
                    flexShrink: 0,
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            border: "1px solid var(--inner-border)",
            borderRadius: "10px",
            background: "var(--surface-1)",
            minHeight: "320px",
            maxHeight: "420px",
            padding: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {isLoading ? (
            <div
              style={{
                padding: "32px",
                textAlign: "center",
                fontSize: "12px",
                color: "var(--text-tertiary)",
              }}
            >
              Loading catalog…
            </div>
          ) : isError ? (
            <div style={{ padding: "32px", textAlign: "center", fontSize: "12px" }}>
              <p style={{ color: "var(--text-tertiary)" }}>Failed to load catalog.</p>
              <button type="button" onClick={refetch} style={{ marginTop: "8px" }}>
                Retry
              </button>
            </div>
          ) : grouped.length === 0 ? (
            <div
              style={{
                padding: "32px",
                textAlign: "center",
                fontSize: "12px",
                color: "var(--text-tertiary)",
              }}
            >
              No models found.
            </div>
          ) : (
            grouped.map(([groupKey, entries]) => {
              const isProviderGroup = entries[0]?.kind === "model";
              return (
              <div
                key={groupKey}
                style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {isProviderGroup ? (
                    <ProviderIcon name={groupKey} icon={groupKey} size={16} />
                  ) : (
                    <Route size={14} />
                  )}
                  {groupKey}
                  <Badge tone="default">{entries.length}</Badge>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 100%), 1fr))",
                    gap: "8px",
                    minWidth: 0,
                  }}
                >
                  {entries.map((e) => {
                    const sel = isSelected(e.qualified);
                    return (
                      <button
                        key={e.qualified}
                        type="button"
                        onClick={() => handlePick(e.qualified)}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "4px",
                          padding: "10px 12px",
                          borderRadius: "10px",
                          border: sel ? "1px solid var(--accent)" : "1px solid var(--inner-border)",
                          background: sel ? "var(--accent-soft)" : "var(--surface-2)",
                          cursor: "pointer",
                          textAlign: "left",
                          position: "relative",
                          minWidth: 0,
                          overflow: "hidden",
                        }}
                      >
                        {sel && (
                          <Check
                            size={12}
                            style={{
                              position: "absolute",
                              top: "8px",
                              right: "8px",
                              color: "var(--accent)",
                            }}
                          />
                        )}
                        <span
                          title={e.qualified}
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            fontWeight: 600,
                            color: sel ? "var(--accent)" : "var(--text-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            paddingRight: sel ? "16px" : 0,
                            width: "100%",
                          }}
                        >
                          {e.modelId}
                        </span>
                        <span
                          title={e.qualified}
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "10px",
                            color: "var(--text-tertiary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            width: "100%",
                          }}
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
                                <span title={UNKNOWN_LIMITS_TOOLTIP} style={{ cursor: "help" }}>
                                  n/a ctx
                                </span>
                              )}
                              {` · `}
                              {e.entry.outputLimit ? (
                                `${formatShortTokens(e.entry.outputLimit)} out`
                              ) : (
                                <span title={UNKNOWN_LIMITS_TOOLTIP} style={{ cursor: "help" }}>
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
