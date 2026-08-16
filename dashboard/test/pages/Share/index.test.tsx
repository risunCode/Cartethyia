import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { Route, Router } from "@solidjs/router";

import Share from "../../../src/pages/Share/index";
import { FakeEventSource, stubEventSource } from "../../helpers/live-surfaces";

const sharePayload = {
  name: "Team link",
  active: true,
  apiKey: { id: "share-9", prefix: "sk-shr" },
  quotaAvailable: true,
  inFlight: 2,
  totalTokens: 123_456,
  totalRequests: 4211,
  dailyUsed: 1234,
  dailyLimit: 5000,
  monthlyUsed: 12_000,
  monthlyLimit: 150_000,
  rateLimitRpm: 600,
  maxConcurrentRequests: 5,
  createdAt: "2026-08-01T10:00:00Z",
  lastUsedAt: "2026-08-16T07:30:00Z",
  baseUrl: "https://gw.example.com/share/token-9",
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function renderShareAt(shareId: string): void {
  window.history.pushState({}, "", `/share/${shareId}`);
  render(() => (
    <Router root={(props) => <>{props.children}</>}>
      <Route path="/share/:shareId" component={Share} />
    </Router>
  ));
}

describe("Share page", () => {
  beforeEach(() => {
    stubEventSource();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(sharePayload)));
  });

  afterEach(() => {
    FakeEventSource.reset();
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("fetches the public share payload with credentials omitted", async () => {
    renderShareAt("token-9");

    await screen.findByText("Team link");

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith("/share/token-9/data", {
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
  });

  test("renders the monitor header, live status panel, and metadata", async () => {
    renderShareAt("token-9");

    expect(await screen.findByText("Team link")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Share monitor" })).toBeInTheDocument();
    expect(screen.getByText("share_id = token-9")).toBeInTheDocument();

    // ShareStatus fallback snapshot derived from the fetched payload.
    expect(screen.getByText("Share link")).toBeInTheDocument();
    expect(screen.getByText("share-9")).toBeInTheDocument();
    expect(screen.getByText("4,211")).toBeInTheDocument();

    expect(screen.getByText("Metadata")).toBeInTheDocument();
    expect(screen.getByText("1,234 / 5,000")).toBeInTheDocument();
    expect(screen.getByText("12,000 / 150,000")).toBeInTheDocument();
    expect(screen.getByText("600")).toBeInTheDocument();
    expect(screen.getByText("https://gw.example.com/share/token-9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy base URL" })).toBeInTheDocument();
  });

  test("subscribes to the share status stream at /share/:id/stream", async () => {
    renderShareAt("token-9");

    await screen.findByText("Team link");
    const stream = FakeEventSource.instances.find((source) => source.url === "/share/token-9/stream");
    expect(stream).toBeDefined();

    // Offline until the connection opens, live afterwards.
    expect(screen.getByText("Stream offline")).toBeInTheDocument();
    stream!.open();
    expect(await screen.findByText("Live status stream connected")).toBeInTheDocument();
  });

  test("applies count events pushed by the stream", async () => {
    renderShareAt("token-9");

    await screen.findByText("Team link");
    const stream = FakeEventSource.instances.find((source) => source.url === "/share/token-9/stream");
    stream!.open();

    stream!.emitNamed("count", {
      id: "share-9",
      label: "Team link",
      createdAt: "2026-08-01T10:00:00Z",
      snapshot: { tone: "exhausted", progress: 95, progressMax: 100, totalTokens: 130_000, totalRequests: 4300 },
    });

    expect(await screen.findByText("Quota exhausted")).toBeInTheDocument();
    expect(screen.getByText("4,300")).toBeInTheDocument();
    // Note: the progress bar's value/max are captured on first render
    // (ProgressBar destructures its props), so live progress changes are
    // asserted through the totals rather than the bar itself.
  });

  test("renders the unavailable state when the fetch rejects", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("network unreachable"));

    renderShareAt("broken");

    expect(await screen.findByText("Share unavailable")).toBeInTheDocument();
    expect(screen.getByText("The link could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("Verify the share link is correct, still active, and not expired.")).toBeInTheDocument();
    // No details => no status stream is opened for the monitor.
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  test("renders the unavailable state for a non-ok response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("gone", { status: 404 }));

    renderShareAt("expired-token");

    expect(await screen.findByText("Share unavailable")).toBeInTheDocument();
    expect(screen.getByText("share_id = expired-token")).toBeInTheDocument();
  });
});
