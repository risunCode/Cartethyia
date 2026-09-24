import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ShareMonitorData, ShareSetupData } from "../../lib/hooks/share-data";

// The share page reads `window.location` for its data path and derives the
// Base URL it tells the recipient to call. A minimal stub is enough for
// server-side rendering because effects never run here.
(globalThis as { window?: unknown }).window = {
  location: {
    origin: "https://share.example.test",
    pathname: "/share/token",
    reload: () => undefined,
  },
};

interface ShareState {
  data: ShareMonitorData | ShareSetupData | null;
  error: string | null;
  loading: boolean;
}

let shareState: ShareState = { data: null, error: null, loading: true };

mock.module("../../lib/hooks/share-data", () => ({
  useShareData: (): ShareState => shareState,
}));

const { SharePage } = await import("./page");

function monitor(overrides: Partial<ShareMonitorData> = {}): ShareMonitorData {
  return {
    name: "Bansos Token",
    active: true,
    apiKey: { id: "abcdef12-3456-7890-abcd-ef1234567890", prefix: "rk_", key: "rk_secret_value", active: true },
    quotaAvailable: true,
    dailyUsed: 0,
    dailyLimit: null,
    dailyRemaining: null,
    monthlyUsed: 0,
    monthlyLimit: null,
    monthlyRemaining: null,
    oneTimeLimit: null,
    oneTimeUsed: 0,
    oneTimeRemaining: null,
    rateLimitRpm: null,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: [],
    modelDenylist: null,
    notes: { title: null, subtitle: null, body: null },
    createdAt: "2026-01-02T00:00:00.000Z",
    lastUsedAt: null,
    totalTokens: 0,
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

function render(): string {
  return renderToStaticMarkup(createElement(SharePage));
}

describe("share page", () => {
  test("renders a loading shell before data arrives", () => {
    shareState = { data: null, error: null, loading: true };
    const markup = render();
    expect(markup).toContain("animate-pulse");
    expect(markup).not.toContain("Bansos Token");
  });

  test("renders an unavailable state with a retry action", () => {
    shareState = { data: null, error: "This shared passage is unavailable.", loading: false };
    const markup = render();
    expect(markup).toContain("Not available");
    expect(markup).toContain("This shared passage is unavailable.");
    expect(markup).toContain("Retry");
  });

  test("shows the full key, base URL and title for an unlimited key", () => {
    shareState = { data: monitor(), error: null, loading: false };
    const markup = render();
    expect(markup).toContain("Bansos Token");
    expect(markup).toContain("Live");
    expect(markup).toContain("Unlimited");
    // The Base URL is the origin serving this page, never a server-sent value:
    // a share reached through a tunnel must not advertise the gateway's own
    // loopback OAuth origin.
    expect(markup).toContain("https://share.example.test");
    expect(markup).toContain("https://share.example.test/v1");
    // The monitor view reveals the full key so the recipient can use it.
    expect(markup).toContain("rk_secret_value");
    expect(markup).toContain("No restriction");
  });

  test("renders the active theme trigger and persists a theme-ready surface", () => {
    shareState = { data: monitor(), error: null, loading: false };
    const markup = render();
    expect(markup).toContain("Cyberpunk");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-share-theme="cyberpunk"');
    expect(markup).toContain("share-theme-picker");
  });

  test("explains when a legacy key has no recoverable secret", () => {
    shareState = {
      data: monitor({ apiKey: { id: "key-1", prefix: "rk_", key: null, active: true } }),
      error: null,
      loading: false,
    };
    const markup = render();
    expect(markup).toContain("Key predates share-secret storage");
    expect(markup).not.toContain("rk_secret_value");
  });

  test("groups allowed models by provider", () => {
    shareState = {
      data: monitor({
        modelAllowlist: ["openai/gpt-5", "anthropic/claude-x", "anthropic/claude-y"],
      }),
      error: null,
      loading: false,
    };
    const markup = render();
    expect(markup).toContain("anthropic");
    expect(markup).toContain("openai");
    expect(markup).toContain("claude-x");
    // Provider headers expose how many models each group holds.
    expect(markup).toContain(">2<");
  });

  test("renders quota bars for a limited key", () => {
    shareState = {
      data: monitor({
        dailyLimit: 1_000_000,
        dailyUsed: 250_000,
        monthlyLimit: 10_000_000,
        monthlyUsed: 1_000_000,
        totalTokens: 1_000_000,
        totalRequests: 42,
        successCount: 40,
        errorCount: 2,
      }),
      error: null,
      loading: false,
    };
    const markup = render();
    expect(markup).toContain("Limited");
    expect(markup).toContain("Daily");
    expect(markup).toContain("Monthly");
    expect(markup).toContain("250,000");
    expect(markup).toContain("1,000,000");
    expect(markup).toContain("Success");
    expect(markup).toContain("Error");
  });

  test("renders the one-time setup handoff with the page's own origin", () => {
    // The setup page is reached once, at a different path, and must show the
    // same Base URL rule as the monitor page rather than a server-sent value.
    const stub = (globalThis as { window: { location: { pathname: string } } }).window;
    const originalPath = stub.location.pathname;
    stub.location.pathname = "/share/setup/token";
    try {
      shareState = {
        data: { name: "Bansos Token", key: "rk_secret_value", expiresAt: null },
        error: null,
        loading: false,
      };
      const markup = render();
      expect(markup).toContain("One-time setup");
      expect(markup).toContain("https://share.example.test");
      expect(markup).toContain("rk_secret_value");
    } finally {
      stub.location.pathname = originalPath;
    }
  });

  test("renders owner notes when present", () => {
    shareState = {
      data: monitor({
        notes: { title: "Bansos", subtitle: "Come and save your tokens", body: "Use wisely." },
      }),
      error: null,
      loading: false,
    };
    const markup = render();
    expect(markup).toContain("Notes");
    expect(markup).toContain("Come and save your tokens");
    expect(markup).toContain("Use wisely.");
  });
});
