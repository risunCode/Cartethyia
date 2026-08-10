import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";
import { useWindowedList } from "../../src/hooks/use-windowed-list";

function Probe({ count, rowHeight, overscan = 2 }: { count: number; rowHeight: number; overscan?: number }): ReactElement {
  const items = Array.from({ length: count }, (_, index) => index);
  const { containerRef, onScroll, visibleItems, topPadding, bottomPadding } = useWindowedList(items, rowHeight, overscan);
  return (
    <div ref={containerRef} data-testid="list" onScroll={onScroll}>
      <output role="status">{JSON.stringify({ visibleItems, topPadding, bottomPadding })}</output>
    </div>
  );
}

describe("useWindowedList", () => {
  test("renders the initial window with accurate padding", () => {
    render(<Probe count={100} rowHeight={10} />);

    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({
      visibleItems: Array.from({ length: 62 }, (_, index) => index),
      topPadding: 0,
      bottomPadding: 380,
    }));
  });

  test("updates the window after scrolling", async () => {
    render(<Probe count={100} rowHeight={10} />);
    const list = screen.getByTestId("list");
    Object.defineProperty(list, "scrollTop", { configurable: true, value: 200 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });

    fireEvent.scroll(list);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({
      visibleItems: Array.from({ length: 14 }, (_, index) => index + 18),
      topPadding: 180,
      bottomPadding: 680,
    })));
  });
});
