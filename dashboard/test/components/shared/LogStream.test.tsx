import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";

import { LogStream } from "../../../src/components/shared/LogStream";
import { closeAllSSEConnections } from "../../../src/lib/sse";
import { FakeEventSource, stubEventSource, stubVirtualLayout } from "../../helpers/live-surfaces";

function stream(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { timestamp: "2026-08-16T10:00:00Z", level: "info", source: "proxy.core", message: "routed request", ...overrides };
}

describe("LogStream", () => {
  beforeEach(() => {
    stubEventSource();
    stubVirtualLayout();
    // jsdom does not implement Element.scrollTo; the pane's auto-follow
    // smooth-scroll would otherwise surface as uncaught errors.
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, writable: true, value: () => {} });
  });

  afterEach(() => {
    closeAllSSEConnections();
    FakeEventSource.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("starts disconnected with an empty buffer", () => {
    const { container } = render(() => <LogStream url="/console/logs/stream" level="info" />);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/console/logs/stream");
    expect(screen.getByRole("log", { name: "Live console log stream" })).toBeInTheDocument();
    expect(screen.getByText(/Disconnected/)).toBeInTheDocument();
    expect(screen.getByText(/0 \/ 0 entries \(buffer 1000\)/)).toBeInTheDocument();
    expect(screen.getByText("Stream offline")).toBeInTheDocument();

    const scroll = container.querySelector(".console-log-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll?.className).toContain("log-zebra");
  });

  test("streams entries and reports the live connection", () => {
    render(() => <LogStream url="/console/logs/stream/live" level="info" />);

    stream().open();
    expect(screen.getByText(/Streaming/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for log entries…")).toBeInTheDocument();

    // Both wire shapes are accepted: bare log entries and {type, data} envelopes.
    stream().emit(entry({ message: "first request" }));
    stream().emit({ type: "log", data: entry({ level: "warn", message: "upstream slow" }) });

    expect(screen.getByText(/2 \/ 2 entries/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for log entries…")).not.toBeInTheDocument();
    // With a jsdom viewport stub the virtualized rows render their content.
    expect(screen.getByText("first request")).toBeInTheDocument();
    expect(screen.getByText("upstream slow")).toBeInTheDocument();
    expect(screen.getByText("WARN")).toBeInTheDocument();
  });

  test("filters entries below the minimum level", () => {
    render(() => <LogStream url="/console/logs/stream/level" level="warn" />);

    stream().open();
    stream().emit(entry({ level: "info", message: "too chatty" }));
    stream().emit(entry({ level: "error", message: "real failure" }));

    expect(screen.getByText(/1 \/ 2 entries/)).toBeInTheDocument();
    expect(screen.getByText("real failure")).toBeInTheDocument();
    expect(screen.queryByText("too chatty")).not.toBeInTheDocument();
  });

  test("filters entries by source substring", () => {
    render(() => <LogStream url="/console/logs/stream/source" level="debug" source="proxy.core" />);

    stream().open();
    stream().emit(entry({ source: "proxy.core", message: "kept" }));
    stream().emit(entry({ source: "provider.openai", message: "dropped" }));

    expect(screen.getByText(/1 \/ 2 entries/)).toBeInTheDocument();
    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(screen.queryByText("dropped")).not.toBeInTheDocument();
  });

  test("drops payloads that do not normalize to a log entry", () => {
    render(() => <LogStream url="/console/logs/stream/garbage" level="info" />);

    stream().open();
    stream().emit({ type: "log", data: "not-an-object" });
    stream().emit(entry({ message: "valid one" }));

    expect(screen.getByText(/1 \/ 1 entries/)).toBeInTheDocument();
  });

  test("trims the rolling buffer to the configured size", () => {
    render(() => <LogStream url="/console/logs/stream/buffer" level="info" bufferSize={2} />);

    stream().open();
    stream().emit(entry({ message: "oldest" }));
    stream().emit(entry({ message: "middle" }));
    stream().emit(entry({ message: "newest" }));

    expect(screen.getByText(/2 \/ 2 entries \(buffer 2\)/)).toBeInTheDocument();
    expect(screen.queryByText("oldest")).not.toBeInTheDocument();
    expect(screen.getByText("newest")).toBeInTheDocument();
  });

  test("marks the pane reconnecting after a stream error", () => {
    render(() => <LogStream url="/console/logs/stream/flaky" level="info" />);

    stream().open();
    stream().fail();

    expect(screen.getByText(/Reconnecting…/)).toBeInTheDocument();
    expect(screen.queryByText(/Streaming/)).not.toBeInTheDocument();
  });
});
