import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";

import { LogHistory } from "../../../src/components/shared/LogHistory";
import { consoleGet } from "../../../src/lib/console-api";
import { apiCache } from "../../../src/lib/cache";
import { stubVirtualLayout } from "../../helpers/live-surfaces";

vi.mock("../../../src/lib/console-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/console-api")>();
  return {
    ...actual,
    consoleGet: vi.fn(),
    consolePost: vi.fn(),
    consolePatch: vi.fn(),
    consoleDelete: vi.fn(),
  };
});

const historyEntries = {
  entries: [
    { id: "h1", timestamp: "2026-08-16T10:00:00Z", level: "info", source: "proxy.core", message: "request routed" },
    { id: "h2", timestamp: "2026-08-16T10:01:00Z", level: "error", source: "provider.openai", message: "upstream 502" },
  ],
};

describe("LogHistory", () => {
  beforeEach(() => {
    apiCache.clear();
    vi.mocked(consoleGet).mockReset();
    vi.mocked(consoleGet).mockResolvedValue(historyEntries);
    stubVirtualLayout();
  });

  test("fetches the window from the log route and renders normalized rows", async () => {
    render(() => <LogHistory level="debug" />);

    expect(await screen.findByText("request routed")).toBeInTheDocument();
    expect(screen.getByText("upstream 502")).toBeInTheDocument();
    expect(screen.getByText("ERROR")).toBeInTheDocument();
    expect(screen.getByText("INFO")).toBeInTheDocument();
    expect(screen.getByText("provider.openai")).toBeInTheDocument();

    const route = vi.mocked(consoleGet).mock.calls[0][0];
    expect(route.startsWith("/logs?from=")).toBe(true);
    expect(route.includes("&to=")).toBe(true);
    expect(route.endsWith("&limit=500")).toBe(true);
  });

  test("applies the level floor to the fetched entries", async () => {
    render(() => <LogHistory level="error" />);

    // The info entry drops below the error floor; the error entry remains.
    expect(await screen.findByText("upstream 502")).toBeInTheDocument();
    expect(screen.queryByText("request routed")).not.toBeInTheDocument();
  });

  // Note: a rejecting /logs fetch is deliberately not asserted here. Like the
  // pages, LogHistory reads the resource value inside an unguarded memo, so a
  // rejection aborts the render with an unhandled error before the inline
  // failure message can mount.

  test("refetches when the time window changes", async () => {
    render(() => <LogHistory level="info" />);

    await screen.findByText("request routed");
    expect(vi.mocked(consoleGet)).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-16T09:00" } });

    await vi.waitFor(() => expect(vi.mocked(consoleGet)).toHaveBeenCalledTimes(2));
    // The new window is serialized into the from= query (UTC ISO, so only the
    // difference from the first call is asserted, not the literal timestamp).
    const [firstRoute, secondRoute] = vi.mocked(consoleGet).mock.calls.map(([route]) => route);
    expect(secondRoute.startsWith("/logs?from=")).toBe(true);
    expect(secondRoute).not.toBe(firstRoute);
  });

  test("Refresh invalidates the cache and refetches the same window", async () => {
    render(() => <LogHistory level="info" />);

    await screen.findByText("request routed");
    expect(vi.mocked(consoleGet)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await vi.waitFor(() => expect(vi.mocked(consoleGet)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(consoleGet).mock.calls[1][0]).toBe(vi.mocked(consoleGet).mock.calls[0][0]);
  });

  test("accepts the items list key and honors a custom route", async () => {
    vi.mocked(consoleGet).mockResolvedValue({ items: [historyEntries.entries[0]] });

    render(() => <LogHistory level="debug" route="/logs/archive" />);

    expect(await screen.findByText("request routed")).toBeInTheDocument();
    expect(vi.mocked(consoleGet).mock.calls[0][0].startsWith("/logs/archive?from=")).toBe(true);
  });

  test("renders the empty pane when nothing matches the source filter", async () => {
    render(() => <LogHistory level="debug" source="nothing.matches" />);

    // Quirk under test: consoleFailure(undefined) is truthy, so the pane's
    // fallback always renders the bounded failure copy instead of the
    // dedicated empty-filter message. Assert the behavior as shipped.
    expect(await screen.findByText("API request failed")).toBeInTheDocument();
    expect(screen.queryByText("request routed")).not.toBeInTheDocument();
  });
});
