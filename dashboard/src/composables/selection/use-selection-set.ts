import { useCallback, useMemo, useState } from "react";

export interface SelectionSet<TId extends string = string> {
  selectedIds: ReadonlySet<TId>;
  selectedCount: number;
  someSelected: boolean;
  allSelected: (ids: readonly TId[]) => boolean;
  has: (id: TId) => boolean;
  toggle: (id: TId) => void;
  toggleAll: (ids: readonly TId[]) => void;
  clear: () => void;
  replace: (ids: Iterable<TId>) => void;
}

/** Owns selection state for list and batch-action surfaces. */
export function useSelectionSet<TId extends string = string>(): SelectionSet<TId> {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<TId>>(new Set());

  const toggle = useCallback((id: TId) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: readonly TId[]) => {
    setSelectedIds((current) => {
      const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
      return allSelected ? new Set<TId>() : new Set(ids);
    });
  }, []);

  const clear = useCallback(() => setSelectedIds(new Set<TId>()), []);
  const replace = useCallback((ids: Iterable<TId>) => setSelectedIds(new Set(ids)), []);
  const has = useCallback((id: TId) => selectedIds.has(id), [selectedIds]);
  const allSelected = useCallback((ids: readonly TId[]) => selectionCovers(selectedIds, ids), [selectedIds]);
  const selectedCount = selectedIds.size;
  return useMemo(() => ({
    selectedIds,
    selectedCount,
    someSelected: selectedCount > 0,
    allSelected,
    has,
    toggle,
    toggleAll,
    clear,
    replace,
  }), [allSelected, clear, has, replace, selectedCount, selectedIds, toggle, toggleAll]);

}

/** Computes whether the current selection covers a concrete visible item set. */
export function selectionCovers<TId extends string>(selectedIds: ReadonlySet<TId>, ids: readonly TId[]): boolean {
  return ids.length > 0 && ids.every((id) => selectedIds.has(id));
}
