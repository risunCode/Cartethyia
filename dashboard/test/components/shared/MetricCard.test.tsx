import { describe, expect, test } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { Activity, ArrowUpRight } from "lucide-solid";
import { MetricCard, MetricCardSkeleton, MetricGrid } from "../../../src/components/shared/MetricCard";

describe("MetricCard", () => {
  test("renders label, value, and description", () => {
    render(() => <MetricCard label="Requests today" value={1284} description="across 2 providers" />);

    expect(screen.getByText("Requests today")).toBeInTheDocument();
    expect(screen.getByText("1284")).toBeInTheDocument();
    expect(screen.getByText("across 2 providers")).toBeInTheDocument();
  });

  test("renders a JSX value without wrapping it in the tabular span", () => {
    render(() => <MetricCard label="Latency" value={<em>42ms</em>} />);

    const value = screen.getByText("42ms");
    expect(value.tagName).toBe("EM");
  });

  test("renders the configured icon", () => {
    const { container } = render(() => <MetricCard label="In flight" value={3} icon={Activity} />);

    expect(container.querySelector("svg")).not.toBeNull();
  });

  test("swaps the value for a loading placeholder while loading", () => {
    render(() => <MetricCard label="Requests today" value={1284} loading />);

    expect(screen.queryByText("1284")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading Requests today")).toBeInTheDocument();
  });

  test("renders the trend glyph and label with the matching tone", () => {
    render(() => <MetricCard label="Errors" value={2} trend="up" trendLabel="+12%" />);

    const trendLabel = screen.getByText("+12%");
    const trendRow = trendLabel.parentElement;
    expect(trendRow).not.toBeNull();
    expect(trendRow).toHaveTextContent("▲+12%");
    expect(trendRow?.className).toContain("text-[var(--status-success)]");
  });

  test("omits the trend row when no trend label is supplied", () => {
    render(() => <MetricCard label="Errors" value={2} trend="down" />);

    expect(screen.queryByText("▲")).not.toBeInTheDocument();
    expect(screen.queryByText("▼")).not.toBeInTheDocument();
  });

  test("renders a custom icon instead of the default status visuals", () => {
    render(() => <MetricCard label="Share" value={8} icon={ArrowUpRight} tone="info" />);

    expect(screen.getByText("Share")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
  });
});

describe("MetricGrid", () => {
  test("lays children out in the default four column grid", () => {
    const { container } = render(() => (
      <MetricGrid>
        <MetricCard label="One" value={1} />
        <MetricCard label="Two" value={2} />
      </MetricGrid>
    ));

    const grid = container.firstElementChild;
    expect(grid?.className).toContain("grid");
    expect(grid?.className).toContain("lg:grid-cols-4");
    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
  });

  test("supports the compact three column layout", () => {
    const { container } = render(() => <MetricGrid columns={3}>content</MetricGrid>);

    const grid = container.firstElementChild;
    expect(grid?.className).toContain("sm:grid-cols-2");
    expect(grid?.className).toContain("lg:grid-cols-3");
  });
});

describe("MetricCardSkeleton", () => {
  test("exposes a screen-reader label by default", () => {
    render(() => <MetricCardSkeleton />);

    expect(screen.getByText("Loading metric")).toBeInTheDocument();
  });

  test("accepts a custom label and renders placeholder blocks", () => {
    const { container } = render(() => <MetricCardSkeleton label="Loading requests" />);

    expect(screen.getByText("Loading requests")).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
  });
});

