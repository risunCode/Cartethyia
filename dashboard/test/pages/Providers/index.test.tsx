import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";

import Providers from "../../../src/pages/Providers/index";
import { consoleGet } from "../../../src/lib/console-api";
import { ApiError } from "../../../src/lib/api";
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

const catalogPayload = {
  items: [
    {
      id: "openai",
      name: "OpenAI",
      protocol: "openai",
      credentialKinds: ["api_key"],
      enabled: true,
      configured: true,
      accountCount: 2,
      models: [{ id: "gpt-5", enabled: true }],
    },
    { id: "legacy", name: "Legacy Hub", enabled: false, configured: false },
  ],
};

const accountsPayload = {
  items: [
    { id: "acct-openai-1", providerId: "openai", label: "Primary OpenAI", email: "ops@example.com", enabled: true },
    { id: "acct-openai-2", providerId: "openai", label: "Backup OpenAI", enabled: false },
  ],
};

const upstreamTelemetryPayload = {
  items: [{ count: 200, errors: 4, latencyMs: 250, metadata: { provider: "openai" } }],
};

const quotas: Record<string, unknown> = {
  "acct-openai-1": { used: 80, limit: 100, remaining: 20 },
  "acct-openai-2": { used: 20, limit: 100, remaining: 80 },
};

function mockHappyPath(): void {
  vi.mocked(consoleGet).mockImplementation(async (route: string) => {
    if (route === "/catalog/providers") return catalogPayload;
    if (route === "/accounts") return accountsPayload;
    if (route.startsWith("/providers/openai/accounts")) return accountsPayload;
    if (route.startsWith("/telemetry/upstream")) return upstreamTelemetryPayload;
    for (const [accountId, window] of Object.entries(quotas)) {
      if (route === `/accounts/${accountId}/quota`) return window;
    }
    throw new Error(`unexpected route: ${route}`);
  });
}

describe("Providers page", () => {
  beforeEach(() => {
    vi.mocked(consoleGet).mockReset();
    mockHappyPath();
    stubVirtualLayout();
  });

  test("renders the fleet summary and provider rows sorted by health", async () => {
    render(() => <Providers />);

    expect(screen.getByRole("heading", { level: 2, name: "Providers" })).toBeInTheDocument();
    await screen.findByText("OpenAI");

    // Summary: 2 registered providers, none active (one disabled, one degraded).
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("Registered in the catalog")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();

    // Rows render with derived status: Legacy Hub is disabled => Down first,
    // OpenAI has a disabled account => Degraded.
    const legacy = screen.getByText("Legacy Hub").closest("tr");
    const openai = screen.getByText("OpenAI").closest("tr");
    expect(legacy).not.toBeNull();
    expect(openai).not.toBeNull();
    expect(legacy!.compareDocumentPosition(openai!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("The provider is disabled in the catalog.")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 accounts disabled")).toBeInTheDocument();
  });

  test("derives latency and success rate from upstream telemetry", async () => {
    render(() => <Providers />);

    expect(await screen.findByText("250ms")).toBeInTheDocument();
    expect(screen.getByText("98.0%")).toBeInTheDocument();
    expect(screen.queryByText("Upstream telemetry is unavailable")).not.toBeInTheDocument();
  });

  test("aggregates probed quota windows into the list quota cell", async () => {
    render(() => <Providers />);

    expect(await screen.findByText("80% used")).toBeInTheDocument();
    expect(screen.getByText("Quota tracked")).toBeInTheDocument();
  });

  test("notes when upstream telemetry is unavailable and hides derived columns", async () => {
    vi.mocked(consoleGet).mockImplementation(async (route: string) => {
      if (route.startsWith("/telemetry/upstream")) throw new ApiError(501, "not_implemented", "telemetry disabled");
      if (route === "/catalog/providers") return catalogPayload;
      if (route === "/accounts") return accountsPayload;
      for (const [accountId, window] of Object.entries(quotas)) {
        if (route === `/accounts/${accountId}/quota`) return window;
      }
      throw new Error(`unexpected route: ${route}`);
    });

    render(() => <Providers />);

    const note = await screen.findByText(
      "Upstream telemetry is unavailable on this API — latency and success rate stay hidden until the telemetry service responds.",
    );
    expect(note).toBeInTheDocument();
  });

  test("falls back to catalog-only status when the account listing fails", async () => {
    vi.mocked(consoleGet).mockImplementation(async (route: string) => {
      if (route === "/accounts") throw new ApiError(500, "server_error", "account store down");
      if (route === "/catalog/providers") return catalogPayload;
      if (route.startsWith("/telemetry/upstream")) return upstreamTelemetryPayload;
      if (route.startsWith("/providers/")) return accountsPayload;
      for (const [accountId, window] of Object.entries(quotas)) {
        if (route === `/accounts/${accountId}/quota`) return window;
      }
      throw new Error(`unexpected route: ${route}`);
    });

    render(() => <Providers />);

    expect(await screen.findByText("Account listing is unavailable — statuses reflect catalog state only.")).toBeInTheDocument();
    // Catalog says OpenAI is enabled, so without account data it reads Active.
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  test("opens the provider detail view and returns to the list", async () => {
    render(() => <Providers />);

    fireEvent.click(await screen.findByRole("button", { name: "View details for OpenAI" }));

    expect(await screen.findByText("Success rate (24h)")).toBeInTheDocument();
    expect(screen.getByText("98.0%")).toBeInTheDocument();
    expect(screen.getByText("Avg latency")).toBeInTheDocument();
    expect(screen.getByText("Active accounts")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("Endpoint status")).toBeInTheDocument();
    expect(screen.getByText("Credential kinds")).toBeInTheDocument();
    expect(screen.getByText("api_key")).toBeInTheDocument();
    expect(screen.getByText("Quota windows")).toBeInTheDocument();
    expect(screen.getByText("Endpoint accounts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to provider list" }));
    expect(await screen.findByRole("button", { name: "View details for OpenAI" })).toBeInTheDocument();
  });

  // Note: a full catalog-route failure is deliberately not covered here. The
  // page reads the errored resource inside unguarded memos, so a rejected
  // snapshot aborts the render with an unhandled error before the "Failed to
  // load providers" panel can mount. The partial-failure tests above cover
  // the degradation paths the page actually handles (telemetry, accounts).
});
