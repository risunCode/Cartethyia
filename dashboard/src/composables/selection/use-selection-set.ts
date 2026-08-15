import { createMemo, createSignal, type Accessor } from "solid-js";

export interface SelectionSet<TId extends string = string> {
  selectedIds: Accessor<ReadonlySet<TId>>;
  selectedCount: Accessor<number>;
  someSelected: Accessor<boolean>;
  allSelected: (ids: readonly TId[]) => boolean;
  has: (id: TId) => boolean;
  toggle: (id: TId) => void;
  toggleAll: (ids: readonly TId[]) => void;
  clear: () => void;
  replace: (ids: Iterable<TId>) => void;
}

/** Owns selection state for list and batch-action surfaces. */
export function useSelectionSet<TId extends string = string>(): SelectionSet<TId> {
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<TId>>(new Set<TId>());

  const toggle = (id: TId): void => {
    const next = new Set(selectedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(() => next);
  };

  const toggleAll = (ids: readonly TId[]): void => {
    const current = selectedIds();
    const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
    setSelectedIds(() => (allSelected ? new Set<TId>() : new Set(ids)));
  };

  const clear = (): void => { setSelectedIds(() => new Set<TId>()); };
  const replace = (ids: Iterable<TId>): void => { setSelectedIds(() => new Set(ids)); };
  const has = (id: TId): boolean => selectedIds().has(id);
  const allSelected = (ids: readonly TId[]): boolean => selectionCovers(selectedIds(), ids);
  const selectedCount = createMemo(() => selectedIds().size);
  const someSelected = createMemo(() => selectedCount() > 0);
  return {
    selectedIds,
    selectedCount,
    someSelected,
    allSelected,
    has,
    toggle,
    toggleAll,
    clear,
    replace,
  };
}

/** Computes whether the current selection covers a concrete visible item set. */
export function selectionCovers<TId extends string>(selectedIds: ReadonlySet<TId>, ids: readonly TId[]): boolean {
  return ids.length > 0 && ids.every((id) => selectedIds.has(id));
}
