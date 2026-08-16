import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";

import { ShareStatus, type ShareStatusSnapshot } from "../../../src/components/shared/ShareStatus";
import { closeAllSSEConnections } from "../../../src/lib/sse";
import { FakeEventSource, stubEventSource } from "../../helpers/live-surfaces";

const fallback: ShareStatusSnapshot = {
  id: "share-1",
  label: "Team link",
  tone: "active",
  progress: 40,
  progressMax: 200,
  totalTokens: 1_000,
  totalRequests: 25,
  createdAt: "2026-08-01T10:00:00Z",
  lastUsedAt: "2026-08-16T07:30:00Z",
  expiresAt: null,
  inFlight: 2,
};

function stream(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

describe("ShareStatus", () => {
  beforeEach(() => {
    stubEventSource();
  });

  afterEach(() => {
    closeAllSSEConnections();
    FakeEventSource.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("renders the caller-supplied fallback snapshot before any event", () => {
    render(() => <ShareStatus url="/share/share-1/stream" snapshot={fallback} />);

    expect(screen.getByText("Share link")).toBeInTheDocument();
    expect(screen.getByText("Team link")).toBeInTheDocument();
    expect(screen.getByText("share-1")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    // 40 of 200 renders as 20%.
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Stream offline")).toBeInTheDocument();
  });

  test("shows the pending placeholder without a snapshot", () => {
    render(() => <ShareStatus url="/share/share-2/stream" fallbackMessage="Awaiting first status update…" />);

    expect(screen.getByText("Pending share")).toBeInTheDocument();
    expect(screen.getByText("Initializing")).toBeInTheDocument();
    expect(screen.getByText("Awaiting first status update…")).toBeInTheDocument();
  });

  test("goes live on connect and applies full snapshot events", () => {
    render(() => <ShareStatus url="/share/share-3/stream" snapshot={fallback} />);

    const source = stream();
    expect(source.url).toBe("/share/share-3/stream");
    source.open();

    expect(screen.getByText("Live status stream connected")).toBeInTheDocument();

    source.emit({
      id: "share-3",
      label: "Relay link",
      createdAt: "2026-08-02T10:00:00Z",
      snapshot: { tone: "exhausted", progress: 95, progressMax: 100, totalTokens: 130_000, totalRequests: 4_300 },
    });

    expect(screen.getByText("Relay link")).toBeInTheDocument();
    expect(screen.getByText("Quota exhausted")).toBeInTheDocument();
    expect(screen.getByText("4,300")).toBeInTheDocument();
    // The fallback snapshot no longer drives the badge.
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  test("applies count-style events on the named channel", () => {
    render(() => <ShareStatus url="/share/share-4/stream" snapshot={fallback} events={["count"]} />);

    const source = stream();
    source.open();
    source.emitNamed("count", {
      id: "share-4",
      label: "Team link",
      createdAt: "2026-08-01T10:00:00Z",
      snapshot: { tone: "active", progress: 10, progressMax: 100, totalTokens: 2_000, totalRequests: 30 },
    });
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();

    // Count-only events ({inFlight}) refresh the in-flight figure while the
    // live snapshot (tone, label, totals) stays put.
    source.emitNamed("count", { inFlight: 7 });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Team link")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  test("reports the stream error and reconnect state after a failure", () => {
    render(() => <ShareStatus url="/share/share-5/stream" snapshot={fallback} />);

    const source = stream();
    source.open();
    source.fail();

    expect(screen.getByRole("alert")).toHaveTextContent("Stream error: Connection failed");
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText("Live status stream connected")).not.toBeInTheDocument();
  });

  test("flags a connected stream as quiet once events stop arriving", () => {
    vi.useFakeTimers();
    render(() => <ShareStatus url="/share/share-6/stream" snapshot={fallback} />);

    const source = stream();
    source.open();
    source.emit({ inFlight: 3 });
    expect(screen.getByText("Live status stream connected")).toBeInTheDocument();

    // Past the 30s staleness window (ticked every 5s) the link reads as quiet.
    vi.advanceTimersByTime(35_000);
    expect(screen.getByText("Quiet — no recent events")).toBeInTheDocument();
  });
});
