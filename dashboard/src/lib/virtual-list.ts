import { createVirtualizer, type Virtualizer } from "@tanstack/solid-virtual";
import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

export interface VirtualList<T> {
  containerRef: (element: HTMLDivElement) => void;
  virtualizer: Virtualizer<HTMLDivElement, HTMLTableRowElement>;
  visibleItems: Accessor<readonly T[]>;
  topPadding: Accessor<number>;
  bottomPadding: Accessor<number>;
}

/** Create a fixed-row virtual list backed by TanStack's Solid virtualizer. */
export function createVirtualList<T>(items: Accessor<readonly T[]>, rowHeight: number, overscan = 4): VirtualList<T> {
  let element: HTMLDivElement | null = null;
  const [container, setContainer] = createSignal<HTMLDivElement | null>(null);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    get count() { return items().length; },
    getScrollElement: () => element,
    estimateSize: () => rowHeight,
    overscan,
  });
  const containerRef = (next: HTMLDivElement) => {
    element = next;
    setContainer(next);
    virtualizer._willUpdate();
  };
  const visible = createMemo(() => virtualizer.getVirtualItems().map((entry) => items()[entry.index]).filter((item): item is T => item !== undefined));
  const topPadding = createMemo(() => virtualizer.getVirtualItems()[0]?.start ?? 0);
  const bottomPadding = createMemo(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    return last ? Math.max(0, virtualizer.getTotalSize() - last.end) : 0;
  });
  createMemo(() => container());
  onCleanup(() => { element = null; });
  return { containerRef, virtualizer, visibleItems: visible, topPadding, bottomPadding };
}
