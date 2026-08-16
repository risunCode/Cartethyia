import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createVirtualList, type VirtualList } from "../../src/lib/virtual-list";

function mountList<T>(items: () => readonly T[], rowHeight: number, overscan?: number): VirtualList<T> {
  let list!: VirtualList<T>;
  createRoot(() => {
    list = createVirtualList(items, rowHeight, overscan);
  });
  return list;
}

function sizedContainer(height: number, width = 800): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: width });
  document.body.appendChild(element);
  return element;
}

describe("createVirtualList", () => {
  const attached: HTMLDivElement[] = [];

  afterEach(() => {
    for (const element of attached.splice(0)) element.remove();
  });

  test("exposes an empty window and zero paddings before a container is attached", () => {
    const list = mountList(() => ["a", "b", "c"], 40);

    expect(list.visibleItems()).toEqual([]);
    expect(list.topPadding()).toBe(0);
    expect(list.bottomPadding()).toBe(0);
    // Row measurements still describe the full list.
    expect(list.virtualizer.getTotalSize()).toBe(120);
  });

  test("windows only the rows that fit a sized container plus overscan", async () => {
    const items = Array.from({ length: 10 }, (_, index) => `row-${index}`);
    const list = mountList(() => items, 40);
    const element = sizedContainer(200);
    attached.push(element);

    list.containerRef(element);

    await vi.waitFor(() => expect(list.visibleItems()).toHaveLength(9));
    expect(list.visibleItems()).toEqual(items.slice(0, 9));
    expect(list.topPadding()).toBe(0);
    expect(list.virtualizer.getTotalSize()).toBe(400);
    // The tail padding covers everything below the rendered window.
    expect(list.bottomPadding()).toBe(400 - 9 * 40);
  });

  test("honours a custom overscan setting", async () => {
    const items = Array.from({ length: 10 }, (_, index) => `row-${index}`);
    const list = mountList(() => items, 40, 0);
    const element = sizedContainer(200);
    attached.push(element);

    list.containerRef(element);

    await vi.waitFor(() => expect(list.visibleItems()).toHaveLength(5));
    expect(list.visibleItems()).toEqual(items.slice(0, 5));
  });

  test("renders every row without tail padding when the list is shorter than the viewport", async () => {
    const list = mountList(() => ["a", "b", "c"], 50);
    const element = sizedContainer(200);
    attached.push(element);

    list.containerRef(element);

    await vi.waitFor(() => expect(list.visibleItems()).toEqual(["a", "b", "c"]));
    expect(list.topPadding()).toBe(0);
    expect(list.bottomPadding()).toBe(0);
  });

  test("recomputes totals when the backing items change", async () => {
    const [items, setItems] = createSignal<readonly string[]>(["a", "b", "c"]);
    const list = mountList(items, 40);
    expect(list.virtualizer.getTotalSize()).toBe(120);

    setItems(["a", "b", "c", "d", "e"]);

    await vi.waitFor(() => expect(list.virtualizer.getTotalSize()).toBe(200));
  });
});
