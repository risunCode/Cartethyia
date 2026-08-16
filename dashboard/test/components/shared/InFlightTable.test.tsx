import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";

import { InFlightTable, SSEInFlightTable, type InFlightRow } from "../../../src/components/shared/InFlightTable";
import { closeAllSSEConnections } from "../../../src/lib/sse";
import { FakeEventSource, stubEventSource, stubVirtualLayout } from "../../helpers/live-surfaces";

const rows: InFlightRow[] = [
  { id: "r1", model: "gpt-5", provider: "openai", ip: "203.0.113.7", startedAt: new Date(Date.now() - 4_000).toISOString(), ageMs: 4_000, bytes: 1_024 },
  { id: "r2", model: "claude-3", provider: "anthropic", ip: "198.51.100.2", startedAt: new Date(Date.now() - 60_000).toISOString(), ageMs: 60_000, bytes: null },
];

function stream(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

describe("InFlightTable", () => {
  beforeEach(() => {
    stubVirtualLayout();
  });

  test("renders the empty state with the idle status", () => {
    render(() => <InFlightTable rows={[]} status="idle" />);

    expect(screen.getByText("No in-flight requests.")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("0 active")).toBeInTheDocument();
  });

  test("renders rows with the live status and per-row details", () => {
    render(() => <InFlightTable rows={rows} status="connected" />);

    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText("1,024")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "In-flight requests" })).toBeInTheDocument();
  });

  test("shows the loading skeleton while no rows arrived yet", () => {
    render(() => <InFlightTable rows={[]} loading status="connecting" />);

    expect(screen.getByLabelText("Loading in-flight rows")).toBeInTheDocument();
    expect(screen.getByText("Connecting")).toBeInTheDocument();
  });

  test("honors a custom empty message", () => {
    render(() => <InFlightTable rows={[]} emptyMessage="Waiting for first in-flight event…" />);

    expect(screen.getByText("Waiting for first in-flight event…")).toBeInTheDocument();
  });
});

describe("SSEInFlightTable", () => {
  beforeEach(() => {
    stubEventSource();
    stubVirtualLayout();
  });

  afterEach(() => {
    closeAllSSEConnections();
    FakeEventSource.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("opens the stream and shows the waiting empty state", () => {
    render(() => <SSEInFlightTable streamUrl="/console/telemetry/in-flight/stream" emptyMessage="Waiting for first in-flight event…" />);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/console/telemetry/in-flight/stream");
    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getByText("Waiting for first in-flight event…")).toBeInTheDocument();
  });

  test("renders aggregate counters and the active total from count events", () => {
    render(() => <SSEInFlightTable streamUrl="/stream/aggregates" />);

    stream().open();
    stream().emit({ inFlight: 2, waiters: 1, grants: 3, rows });

    expect(screen.getByText("2 in-flight")).toBeInTheDocument();
    expect(screen.getByText("1 queued · 3 granted")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    // The header count tracks the buffered rows.
    expect(screen.getByText("2 active")).toBeInTheDocument();
    // Note: the inner table's virtualizer captures `count` once at mount, so
    // rows that only arrive via the stream stay virtualized away; the counts
    // above are the reactive surface for stream-driven updates.
  });

  test("replaces the buffered rows on snapshot events", () => {
    render(() => <SSEInFlightTable streamUrl="/stream/snapshots" emptyMessage="Nothing in flight." />);

    stream().open();
    expect(screen.getByText("Nothing in flight.")).toBeInTheDocument();

    stream().emit({ type: "snapshot", data: [rows[0]] });
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in flight.")).not.toBeInTheDocument();

    stream().emit({ type: "snapshot", data: rows });
    expect(screen.getByText("2 active")).toBeInTheDocument();
  });

  test("clears the table when a snapshot reports no rows", () => {
    render(() => <SSEInFlightTable streamUrl="/stream/clears" emptyMessage="Nothing in flight." />);

    stream().open();
    stream().emit({ type: "snapshot", data: rows });
    expect(screen.getByText("2 active")).toBeInTheDocument();

    stream().emit({ type: "snapshot", data: [] });
    expect(screen.getByText("Nothing in flight.")).toBeInTheDocument();
    expect(screen.getByText("0 active")).toBeInTheDocument();
  });

  test("returns to the connecting state after a stream error", () => {
    render(() => <SSEInFlightTable streamUrl="/stream/flaky" />);

    stream().open();
    expect(screen.getByText("Live")).toBeInTheDocument();
    stream().fail();

    // The first failure schedules an immediate auto-reconnect, so the badge
    // reads Connecting (driven by the reconnecting state) rather than Live.
    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });
});
